import os
import time
import logging
import threading
import datetime as dt
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

# Thread-safe health state
_healthy = threading.Event()
_healthy.set()


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if _healthy.is_set():
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
        else:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b'unhealthy')

    def log_message(self, *_):
        pass  # suppress access logs


def run_health_server():
    srv = HTTPServer(('', HEALTH_PORT), HealthHandler)
    srv.serve_forever()


def trigger_restart(apps_v1: client.AppsV1Api):
    ts = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    patch = {
        'spec': {
            'template': {
                'metadata': {
                    'annotations': {
                        'eso-operator/restartedAt': ts
                    }
                }
            }
        }
    }
    apps_v1.patch_namespaced_deployment(
        name=DEPLOYMENT_NAME,
        namespace=NAMESPACE,
        body=patch,
    )
    log.info('Rolling restart triggered for %s (ts=%s)', DEPLOYMENT_NAME, ts)


def watch_loop():
    try:
        config.load_incluster_config()
        log.info('Config: in-cluster')
    except config.ConfigException:
        config.load_kube_config()
        log.info('Config: kubeconfig')

    core_v1 = client.CoreV1Api()
    apps_v1 = client.AppsV1Api()

    log.info('Watching secret=%s deployment=%s namespace=%s',
             SECRET_NAME, DEPLOYMENT_NAME, NAMESPACE)

    last_rv = None
    backoff  = 5

    while True:
        try:
            _healthy.set()
            w = watch.Watch()
            for event in w.stream(
                core_v1.list_namespaced_secret,
                namespace=NAMESPACE,
                field_selector=f'metadata.name={SECRET_NAME}',
                timeout_seconds=120,
            ):
                etype  = event['type']
                secret = event['object']
                rv     = secret.metadata.resource_version

                if etype == 'ADDED':
                    last_rv = rv
                    log.info('Secret observed (rv=%s)', rv)

                elif etype == 'MODIFIED':
                    if last_rv and rv != last_rv:
                        log.info(
                            'Secret updated rv %s → %s, triggering restart',
                            last_rv, rv,
                        )
                        trigger_restart(apps_v1)
                    last_rv = rv

                elif etype == 'DELETED':
                    log.warning('Secret %s was deleted!', SECRET_NAME)

            # stream timed out normally — loop again
            backoff = 5

        except client.exceptions.ApiException as e:
            log.error('ApiException %s %s — retry in %ds', e.status, e.reason, backoff)
            _healthy.clear()
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)

        except Exception as e:
            log.error('Unexpected error: %s — retry in %ds', e, backoff)
            _healthy.clear()
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


if __name__ == '__main__':
    t = threading.Thread(target=run_health_server, daemon=True)
    t.start()
    log.info('Health server listening on :%d', HEALTH_PORT)
    watch_loop()
