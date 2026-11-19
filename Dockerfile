# CleanPlan demo: one image serving the API and (if present) the built React frontend.
#   docker build -t cleanplan . && docker run -p 8000:8000 cleanplan   ->  http://localhost:8000
# Runs as a non-root user (uid 1000), as hosted container platforms often require. The app never writes to data/: the plan
# and baseline caches ship prebuilt; anything else goes to /tmp.

# ---- 1. frontend (optional) -------------------------------------------------------------------
FROM node:20-alpine AS frontend
WORKDIR /src
COPY . .
RUN if [ -f frontend/package.json ]; then \
      cd frontend && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) && npm run build; \
    else \
      mkdir -p frontend/dist; \
    fi

# ---- 2. python app -----------------------------------------------------------------------------
FROM python:3.11-slim AS app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1 \
    FRONTEND_DIST=/app/frontend/dist CLEANPLAN_CACHE_DIR=/tmp/cleanplan
RUN pip install --no-cache-dir "uv>=0.5,<1" && useradd -m -u 1000 user
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./
RUN uv sync --frozen --no-dev --no-install-project
# code and data are owned by root and read-only for the app user
COPY backend/app ./app
COPY backend/data ./data
COPY --from=frontend /src/frontend/dist /app/frontend/dist
ENV PATH="/app/.venv/bin:$PATH" HOME=/home/user
USER user
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
