const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../model.js');
const {Store, KEY, RECOVERY} = require('../mobile/web/offline.js');
const copy = value => structuredClone(value);
const session = {user:{id:'alice',email:'a@example.test'},csrf:'secret',emailEnabled:true};
function storage() {
    const map = new Map();
    return {getItem:k=>map.get(k)??null, setItem:(k,v)=>map.set(k,v), removeItem:k=>map.delete(k)};
}
function add(db, title='Солярис') {
    const next=copy(db);next.revision++;
    next.movies.push({id:'m'+next.revision,title,type:'FILM',year:'1972',genre:'',poster:'',tags:[],planned:true,createdAt:''});return next;
}
function fixture() {
    const disk=storage(), store=new Store(disk);store.attach(session,M.blank());
    let remote=M.blank(), user=session, puts=0;
    const request=async (path,method,payload)=>{
        if(path==='/api/session')return copy(user);
        if(method==='PUT') {puts++;if(payload.expectedRevision!==remote.revision)throw Object.assign(Error('conflict'),{status:409});remote={...copy(payload.archive),revision:remote.revision+1};return {revision:remote.revision};}
        return copy(remote);
    };
    return {disk,store,request,set remote(v){remote=v},get remote(){return remote},set user(v){user=v},get puts(){return puts}};
}
test('offline edits survive process restart; no CSRF/password persisted',async()=>{
    const f=fixture();f.store.save(add(f.store.record.data),f.store.raw);
    await f.store.sync(async()=>{throw Error('unreachable')},()=>{});
    const restored=new Store(f.disk);assert.equal(restored.record.data.movies.length,1);assert.equal(restored.pending,true);
    assert.equal(f.disk.getItem(KEY).includes('secret'),false);
    await restored.sync(f.request,()=>{});assert.equal(restored.pending,false);assert.equal(f.remote.movies.length,1);
});
test('server failure with internet available preserves the outbox',async()=>{
    const f=fixture();f.store.save(add(f.store.record.data),f.store.raw);
    await f.store.sync(async(path)=>{if(path==='/api/session')return session;throw Object.assign(Error('503'),{status:503});},()=>{});
    assert.equal(f.store.status,'offline');assert.equal(new Store(f.disk).pending,true);
});
test('edits made while upload is in flight are not acknowledged prematurely',async()=>{
    const f=fixture();f.store.save(add(f.store.record.data),f.store.raw);
    await f.store.sync(async(path,method,payload)=>{
        if(method==='PUT')f.store.save(add(f.store.record.data,'Сталкер'),f.store.raw);
        return f.request(path,method,payload);
    },()=>{});
    assert.equal(f.remote.movies.length,1);assert.equal(f.store.pending,true);
    await f.store.sync(f.request,()=>{});assert.equal(f.remote.movies.length,2);assert.equal(f.store.pending,false);
});
test('lost PUT response is recognized after restart even with reordered JSON keys',async()=>{
    const f=fixture();f.store.save(add(f.store.record.data),f.store.raw);
    await f.store.sync(async(path,method,payload)=>{const answer=await f.request(path,method,payload);if(method==='PUT')throw Error('lost response');return answer;},()=>{});
    f.remote=Object.fromEntries(Object.entries(f.remote).reverse());
    const restored=new Store(f.disk);await restored.sync(f.request,()=>{});
    assert.equal(restored.status,'synced');assert.equal(restored.pending,false);assert.equal(f.puts,1);
});
test('lost response plus a newer local edit recovers and uploads the newer version',async()=>{
    const f=fixture();f.store.save(add(f.store.record.data),f.store.raw);
    await f.store.sync(async(path,method,payload)=>{const answer=await f.request(path,method,payload);if(method==='PUT'){f.store.save(add(f.store.record.data,'Сталкер'),f.store.raw);throw Error('lost');}return answer;},()=>{});
    const restored=new Store(f.disk);await restored.sync(f.request,()=>{});
    assert.equal(f.remote.movies.length,2);assert.equal(restored.pending,false);
});
test('409 conflict preserves both sides and explicit local choice uses a revision guard',async()=>{
    const f=fixture();f.store.save(add(f.store.record.data),f.store.raw);f.remote=add(f.remote,'Другой фильм');
    await f.store.sync(f.request,()=>{});assert.equal(f.store.status,'conflict');assert.equal(f.puts,0);
    f.store.resolve('local');assert.equal(JSON.parse(f.disk.getItem(RECOVERY)).server.movies[0].title,'Другой фильм');
    // Server changes again after the user looked at it; it must not be overwritten.
    f.remote=add(f.remote,'Третий фильм');await f.store.sync(f.request,()=>{});
    assert.equal(f.store.status,'conflict');assert.equal(f.puts,0);
    f.store.resolve('local');await f.store.sync(f.request,()=>{});
    assert.equal(f.remote.movies[0].title,'Солярис');assert.equal(f.store.pending,false);
});
test('explicit server choice preserves local backup',async()=>{
    const f=fixture();f.store.save(add(f.store.record.data),f.store.raw);f.remote=add(f.remote,'Сервер');
    await f.store.sync(f.request,()=>{});f.store.resolve('server');
    assert.equal(f.store.record.data.movies[0].title,'Сервер');assert.equal(f.store.pending,false);
    assert.equal(JSON.parse(f.disk.getItem(RECOVERY)).local.movies[0].title,'Солярис');
});
test('expired or different session never uploads another user archive',async()=>{
    for(const user of [null,{id:'bob'}]) {
        const f=fixture();f.store.save(add(f.store.record.data),f.store.raw);f.user={...session,user};
        await f.store.sync(f.request,()=>{});assert.equal(f.store.status,'auth');assert.equal(f.puts,0);assert.equal(f.store.pending,true);
        assert.throws(()=>f.store.attach({...session,user:{id:'bob'}},M.blank()));
    }
});
test('full disk fails before reporting success, retaining last durable state',()=>{
    const f=fixture(),before=f.store.raw;
    f.disk.setItem=()=>{throw Error('QuotaExceededError')};
    assert.throws(()=>f.store.save(add(f.store.record.data),before));assert.equal(f.store.raw,before);assert.equal(new Store(f.disk).raw,before);
});
test('parallel sync requests serialize; clean server deletions are pulled',async()=>{
    const f=fixture();f.store.save(add(f.store.record.data),f.store.raw);
    await Promise.all([f.store.sync(f.request,()=>{}),f.store.sync(f.request,()=>{})]);assert.equal(f.puts,1);
    f.remote={...M.blank(),revision:2};await f.store.sync(f.request,()=>{});assert.equal(f.store.record.data.movies.length,0);
});
test('corrupt storage is never replaced and concurrent writers are rejected',()=>{
    const disk=storage();disk.setItem(KEY,'broken');assert.throws(()=>new Store(disk));assert.equal(disk.getItem(KEY),'broken');
    const f=fixture(),second=new Store(f.disk);f.store.save(add(f.store.record.data),f.store.raw);
    assert.throws(()=>second.save(add(second.record.data),second.raw));assert.equal(new Store(f.disk).pending,true);
});
