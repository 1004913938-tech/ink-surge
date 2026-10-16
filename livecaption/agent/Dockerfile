FROM python:3.11-slim

WORKDIR /app
RUN pip install --no-cache-dir uv
COPY pyproject.toml ./
COPY livecaption_core ./livecaption_core
COPY livecaption_agent ./livecaption_agent
COPY livecaption_api ./livecaption_api
RUN uv pip install --system --no-cache .

# Default: agent worker. compose overrides `command` for the api service.
CMD ["python", "-m", "livecaption_agent.worker", "start"]
