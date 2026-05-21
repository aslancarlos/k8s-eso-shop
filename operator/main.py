import os
import json
import time
import logging
import threading
import datetime as dt
from collections import deque
from http.server import HTTPServer, BaseHTTPRequestHandler
from kubernetes import client, config, watch

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    datefmt='%Y-%m-%dT%H:%M:%SZ',
)
log = logging.getLogger(__name__)

NAMESPACE       = os.environ.get('WATCH_NAMESPACE',   'eso-shop')
SECRET_NAME     = os.environ.get('WATCH_SECRET',      'eso-shop-db-creds')
DEPLOYMENT_NAME = os.environ.get('TARGET_DEPLOYMENT', 'eso-shop')
HEALTH_PORT     = int(os.environ.get('HEALTH_PORT',   '8080'))

# Shared state (protected by _lock)
_lock        = threading.Lock()
_healthy     = True
_last_rv     = None
_events      = deque(maxlen=20)   # last 20 restart events
_core_v1     = None
_apps_v1     = None


def _now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _get_status():
    """Build status JSON — called from HTTP thread, reads K8s API."""
    try:
        pods = _core_v1.list_namespaced_pod(
            namespace=NAMESPACE,
            label_selector=f'app={DEPLOYMENT_NAME}',
        )
        dep  = _apps_v1.read_namespaced_deployment(
            name=DEPLOYMENT_NAME,
            namespace=NAMESPACE,
        )

        pod_list = []
        for p in pods.items:
            cs   = p.status.container_statuses or []
            ready    = all(c.ready for c in cs) if cs else False
            restarts = sum(c.restart_count for c in cs)
            age_s = None
            if p.metadata.creation_timestamp:
                age_s = int(
                    (dt.datetime.now(dt.timezone.utc) - p.metadata.creation_timestamp).total_seconds()
                )
            pod_list.append({
                'name':     p.metadata.name,
                'phase':    p.status.phase or 'Unknown',
                'ready':    ready,
                'restarts': restarts,
                'age':      age_s,
                'node':     p.spec.node_name,
            })

        with _lock:
            rv     = _last_rv
            events = list(_events)

        return {
            'deployment': {
                'name':      DEPLOYMENT_NAME,
                'desired':   dep.spec.replicas or 0,
                'ready':     dep.status.ready_replicas or 0,
                'available': dep.status.available_replicas or 0,
                'updated':   dep.status.updated_replicas or 0,
            },
            'pods':          pod_list,
            'secretRevision': rv,
            'watchedSecret': SECRET_NAME,
            'namespace':     NAMESPACE,
            'events':        events,
            'operatorHealthy': _healthy,
            'timestamp':     _now_iso(),
        }
    except Exception as e:
        return {'error': str(e), 'timestamp': _now_iso()}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/', '/health'):
            ok = _healthy and _core_v1 is not None
            code, body = (200, b'ok') if ok else (503, b'unhealthy')
            self.send_response(code)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(body)

        elif self.path == '/status':
            data = _get_status()
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *_):
        pass


def run_health_server():
    srv = HTTPServer(('', HEALTH_PORT), Handler)
    srv.serve_forever()


def trigger_restart(apps_v1_: client.AppsV1Api):
    ts    = _now_iso()
    patch = {
        'spec': {
            'template': {
                'metadata': {
                    'annotations': {'eso-operator/restartedAt': ts}
                }
            }
        }
    }
    apps_v1_.patch_namespaced_deployment(
        name=DEPLOYMENT_NAME, namespace=NAMESPACE, body=patch,
    )
    with _lock:
        _events.appendleft({'type': 'RESTART', 'ts': ts, 'secretRevision': _last_rv})
    log.info('Rolling restart triggered (ts=%s)', ts)


def watch_loop():
    global _healthy, _last_rv, _core_v1, _apps_v1

    try:
        config.load_incluster_config()
        log.info('Config: in-cluster')
    except config.ConfigException:
        config.load_kube_config()
        log.info('Config: kubeconfig')

    _core_v1 = client.CoreV1Api()
    _apps_v1 = client.AppsV1Api()

    log.info('Watching secret=%s  deployment=%s  namespace=%s',
             SECRET_NAME, DEPLOYMENT_NAME, NAMESPACE)

    backoff = 5
    while True:
        try:
            _healthy = True
            w = watch.Watch()
            for event in w.stream(
                _core_v1.list_namespaced_secret,
                namespace=NAMESPACE,
                field_selector=f'metadata.name={SECRET_NAME}',
                timeout_seconds=120,
            ):
                etype  = event['type']
                secret = event['object']
                rv     = secret.metadata.resource_version

                if etype == 'ADDED':
                    with _lock:
                        _last_rv = rv
                    log.info('Secret observed (rv=%s)', rv)

                elif etype == 'MODIFIED':
                    with _lock:
                        old_rv   = _last_rv
                        _last_rv = rv
                    if old_rv and rv != old_rv:
                        log.info('Secret updated rv %s → %s', old_rv, rv)
                        trigger_restart(_apps_v1)

                elif etype == 'DELETED':
                    log.warning('Secret %s was deleted!', SECRET_NAME)

            backoff = 5  # reset after clean timeout

        except client.exceptions.ApiException as e:
            log.error('ApiException %s %s — retry in %ds', e.status, e.reason, backoff)
            _healthy = False
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
        except Exception as e:
            log.error('Error: %s — retry in %ds', e, backoff)
            _healthy = False
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


if __name__ == '__main__':
    t = threading.Thread(target=run_health_server, daemon=True)
    t.start()
    log.info('Health/status server on :%d', HEALTH_PORT)
    watch_loop()
