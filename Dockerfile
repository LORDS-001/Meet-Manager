# MeetManager - single-stage image.
#
# The app is local-first: SQLite on disk, a background scheduler in-process and
# a single mailbox. There is no horizontal scaling story here, so the image is
# built for "run it on one box" rather than for a cluster.
#
#   docker build -t meetmanager .
#   docker run -p 8000:8000 -v meetmanager-data:/app/data meetmanager
#
# NOTE ON GOOGLE OAUTH: Settings.redirect_uri is derived from HOST/PORT, and
# HOST is 0.0.0.0 in a container so the port is reachable from outside. That
# makes the derived redirect URI unusable for a real OAuth round trip. To
# connect a real calendar, publish the app on the host it will be reached at
# and set HOST/PORT to match, then register that exact callback URL in Google
# Cloud Console. Sample-data mode works with no configuration at all.

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOST=0.0.0.0 \
    PORT=8000

WORKDIR /app

# Dependencies first so the layer caches across source edits.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY run.py selfcheck.py ./

# config.py creates ./data at import time, so it has to be writable by the
# unprivileged user the container runs as.
RUN useradd --system --uid 10001 --create-home meet \
 && mkdir -p /app/data \
 && chown -R meet:meet /app

USER meet
VOLUME ["/app/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status == 200 else 1)"

# --no-browser stops run.py trying to open a desktop browser in the container.
CMD ["python", "run.py", "--no-browser"]
