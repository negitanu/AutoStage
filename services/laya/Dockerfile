FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/data/huggingface \
    USE_TF=0
WORKDIR /app
COPY services/laya/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt
COPY services ./services
EXPOSE 8001
CMD ["uvicorn", "services.laya.app:app", "--host", "0.0.0.0", "--port", "8001"]
