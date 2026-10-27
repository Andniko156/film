"""Isolated UI test server. Never part of deployment or public URL routes."""
import os
import sys
from pathlib import Path
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, WSGIRequestHandler, make_server
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
os.environ['FILM_TEST']='1'
os.environ['DJANGO_SETTINGS_MODULE']='settings'
import django
django.setup()
from django.core.management import call_command
call_command('migrate',verbosity=0)
from cinema import views

def send_test_mail(subject, body, sender, recipients, **kwargs):
    import json
    Path(os.environ['FILM_TEST_MAILBOX']).write_text(json.dumps({'recipient':recipients[0],'body':body}))
    return 1
views.send_mail=send_test_mail
from django.core.wsgi import get_wsgi_application
class Server(ThreadingMixIn, WSGIServer):
    daemon_threads=True
class Quiet(WSGIRequestHandler):
    def log_message(self,*args): pass
server=make_server('127.0.0.1',int(os.environ['FILM_TEST_PORT']),get_wsgi_application(),server_class=Server,handler_class=Quiet)
print('ready',flush=True)
server.serve_forever()
