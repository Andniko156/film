const {test}=require('node:test');
const assert=require('node:assert/strict');
const M=require('../model.js');
const legacy=[{id:17,title:'Прибытие',type:'FILM',genre:'фантастика, драма',year:2016,dateWatched:'2026-10-20',rating:5,comment:'О языке и выборе',poster:'',dateAdded:'2026-10-20T12:00:00Z'}];
class MemoryStorage {
 constructor(data={}){this.data={...data};}
 getItem(key){return this.data[key]??null;}
 setItem(key,value){this.data[key]=String(value);}
}
test('legacy migration preserves every record, note, rating and original keys',()=>{
 const storage=new MemoryStorage({movies:JSON.stringify(legacy),watchlist:JSON.stringify([{id:17,title:'Сталкер',type:'FILM'}])});
 const result=M.load(storage);assert.equal(result.data.movies.length,2);assert.equal(result.data.views.length,1);
 assert.equal(result.data.views[0].note,legacy[0].comment);assert.equal(result.data.views[0].rating,5);
 assert.equal(result.data.movies[0].year,'2016');assert.equal(storage.getItem('movies'),JSON.stringify(legacy));
 assert.deepEqual(M.load(storage).data,result.data);
});
test('duplicate legacy titles remain separate and keep their history',()=>{
 const db=M.migrate([...legacy,{...legacy[0],comment:'Вторая запись'}],[]);
 assert.equal(db.movies.length,2);assert.equal(db.views.length,2);assert.notEqual(db.movies[0].id,db.movies[1].id);
});
test('invalid legacy dates do not silently overwrite data',()=>{
 const storage=new MemoryStorage({movies:JSON.stringify([{...legacy[0],dateWatched:'2026-02-30'}])});
 assert.throws(()=>M.load(storage));assert.equal(storage.getItem(M.KEY),null);
 assert.ok(storage.getItem('movies').includes('2026-02-30'));
});
test('malformed stored archive blocks writes instead of starting an empty archive',()=>{
 const storage=new MemoryStorage({[M.KEY]:'{broken'});assert.throws(()=>M.load(storage));assert.equal(storage.getItem(M.KEY),'{broken');
});
test('revision comparison prevents overwriting another tab',()=>{
 const storage=new MemoryStorage();const original=M.load(storage);const next=structuredClone(original.data);next.revision++;
 M.persist(storage,next,original.raw);assert.throws(()=>M.persist(storage,original.data,original.raw),/другой вкладке/);
});
test('storage quota failure leaves the previous archive unchanged',()=>{
 const storage=new MemoryStorage();const initial=M.load(storage);storage.setItem=()=>{throw Error('QuotaExceededError')};
 assert.throws(()=>M.persist(storage,{...initial.data,revision:1},initial.raw));assert.equal(storage.getItem(M.KEY),initial.raw);
});
test('repeat watches have independent ratings and notes',()=>{
 const db=M.migrate(legacy,[]),id=db.movies[0].id;
 db.views.push({...db.views[0],id:'rewatch',date:'2026-10-25',rating:3,note:'Другое впечатление'});
 assert.equal(M.movieViews(db,id).length,2);assert.equal(M.latest(db,id).rating,3);assert.equal(db.views[0].rating,5);
 assert.equal(M.filtered(db,{repeat:'yes'}).length,1);assert.equal(M.filtered(db,{rating:'4'}).length,0);
});
test('date/company/mood conditions must match the same watch',()=>{
 const db=M.migrate(legacy,[]);db.views[0].company='С семьёй';db.views[0].mood='Уют';
 db.views.push({...db.views[0],id:'rewatch',date:'2026-10-25',company:'С друзьями',mood:'Восторг'});
 assert.equal(M.filtered(db,{from:'2026-10-24',company:'семьёй'}).length,0);
 assert.equal(M.filtered(db,{from:'2026-10-24',company:'друзьями',mood:'восторг'}).length,1);
});
test('quotes, notes, tags, genres and collection filters work together',()=>{
 const db=M.migrate(legacy,[]),id=db.movies[0].id;db.movies[0].tags=['любимое'];
 db.quotes.push({id:'q',movieId:id,text:'Время',character:'',time:'',note:'',tags:['о выборе'],spoiler:true,createdAt:''});
 db.collections.push({id:'c',name:'На вечер',description:'',movieIds:[id]});
 assert.equal(M.filtered(db,{quotes:'yes',notes:'yes',tag:'любимое',collection:'c',genre:'драма'}).length,1);
 assert.equal(M.filtered(db,{query:'время'}).length,1);assert.equal(M.filtered(db,{quotes:'no'}).length,0);
 assert.equal(M.filtered(db,{genre:'драм'}).length,0);
});
test('deleting a movie removes dependent data but preserves other films',()=>{
 const db=M.migrate(legacy,[{title:'Сталкер'}]);const id=db.movies[0].id;
 db.quotes.push({id:'q',movieId:id,text:'Цитата',character:'',time:'',note:'',tags:[],spoiler:false,createdAt:''});
 db.collections.push({id:'c',name:'Тест',description:'',movieIds:db.movies.map(m=>m.id)});
 M.removeMovie(db,id);M.validate(db);assert.equal(db.movies.length,1);assert.equal(db.views.length,0);assert.equal(db.quotes.length,0);assert.equal(db.collections[0].movieIds.length,1);
});
test('new and legacy backups are supported; unrelated JSON and broken references rejected',()=>{
 const db=M.migrate(legacy,[]);assert.deepEqual(M.decodeBackup(JSON.parse(JSON.stringify(db))),db);
 assert.equal(M.decodeBackup({movies:legacy,watchlist:[]}).views.length,1);
 assert.throws(()=>M.decodeBackup({movies:[]}));assert.throws(()=>M.decodeBackup({version:3}));
 db.views[0].movieId='missing';assert.throws(()=>M.validate(db));
});
test('invalid ratings, duplicate IDs and incomplete saved filters are rejected',()=>{
 const db=M.migrate(legacy,[]);db.views[0].rating=99;assert.throws(()=>M.validate(db));db.views[0].rating=5;
 db.movies.push({...db.movies[0]});assert.throws(()=>M.validate(db));db.movies.pop();
 db.presets.push({id:'p',name:'Фильтр',filters:{}});assert.throws(()=>M.validate(db));
});
