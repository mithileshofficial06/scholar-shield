# OCR + forensics service.
#
# Tesseract is a system package, not a wheel, so this image installs it from
# Debian rather than pip. `tesseract-ocr-eng` is explicit: the base
# `tesseract-ocr` package does not guarantee the English traineddata, and a
# missing language file surfaces as empty OCR results rather than an error.

FROM python:3.12-slim

# libgl and libglib are Pillow's runtime dependencies for image decoding.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-eng \
      libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY scripts ./scripts

# The service parses untrusted uploads, so it does not run as root and owns
# nothing it could write to. See app/main.py for why this process is separate
# from the API at all.
RUN useradd --system --uid 10001 ocr && chown -R ocr:ocr /srv
USER ocr

ENV OCR_TESSERACT_CMD=/usr/bin/tesseract \
    PYTHONUNBUFFERED=1

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
