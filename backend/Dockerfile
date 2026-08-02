FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 XDG_CACHE_HOME=/tmp PATH=/opt/venv/bin:$PATH
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    libpango-1.0-0 \
    libpangoft2-1.0-0 \
    libcairo2 \
    libxml2 \
    libxslt1.1 \
    libjpeg-turbo8 \
    libpng16-16 \
    shared-mime-info \
    fonts-dejavu-core \
    libgdk-pixbuf-2.0-0 \
    libglib2.0-0 \
    ghostscript \
    icc-profiles-free \
  && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
RUN python -m pip install --no-cache-dir --upgrade pip==26.1.2 \
  && apt-get purge -y --auto-remove python3-venv \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 10001 appuser \
  && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/appuser appuser
ENV HOME=/home/appuser
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
COPY alembic.ini .
COPY alembic alembic
COPY scripts scripts
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh \
  && mkdir -p /data \
  && chown -R appuser:appuser /app /data
EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8000","--no-server-header"]

# Source veraPDF CLI (remote URL or local zip in build context).
FROM base AS verapdf-archive
# To update: bump VERAPDF_ZIP_SOURCE + VERAPDF_VERSION and refresh VERAPDF_ZIP_SHA256
# (curl -L "$VERAPDF_ZIP_SOURCE" -o /tmp/verapdf.zip && sha256sum /tmp/verapdf.zip).
ARG VERAPDF_ZIP_SOURCE="https://software.verapdf.org/releases/1.28/verapdf-greenfield-1.28.2-installer.zip"
ARG VERAPDF_ZIP_SHA256="d1693a5f0bf0997180f6d97e8a5568b0cf39e27eee338d439c8adb58435c1e89"
ARG JACKSON_VERSION="2.18.9"
ARG JACKSON_CORE_SHA256="e03144f48c8d5307da2894570b4972aab8c72f22440f8dcdb745be2485ce2024"
ARG JACKSON_ANNOTATIONS_SHA256="798c85b86e7420d0b4eb91e7b3e37d4bee673c61de37a616ba51a7539631e6b7"
ARG JACKSON_DATABIND_SHA256="71595a3f7ff58344ec0496a9f9ec9f623ef7b85b45402d88f1ca261f1bc4b42c"
ARG INSTALL_VERAPDF=true
# software.verapdf.org currently serves an expired certificate; integrity is enforced by the pinned SHA256 below.
RUN if [ "$INSTALL_VERAPDF" = "true" ]; then \
    apt-get update && apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --show-error --location --insecure -o /tmp/verapdf.zip "${VERAPDF_ZIP_SOURCE}" \
    && echo "${VERAPDF_ZIP_SHA256}  /tmp/verapdf.zip" | sha256sum -c - \
    && for artifact in core annotations databind; do \
      curl --fail --show-error --location \
        -o "/tmp/jackson-${artifact}-${JACKSON_VERSION}.jar" \
        "https://repo.maven.apache.org/maven2/com/fasterxml/jackson/core/jackson-${artifact}/${JACKSON_VERSION}/jackson-${artifact}-${JACKSON_VERSION}.jar"; \
    done \
    && echo "${JACKSON_CORE_SHA256}  /tmp/jackson-core-${JACKSON_VERSION}.jar" | sha256sum -c - \
    && echo "${JACKSON_ANNOTATIONS_SHA256}  /tmp/jackson-annotations-${JACKSON_VERSION}.jar" | sha256sum -c - \
    && echo "${JACKSON_DATABIND_SHA256}  /tmp/jackson-databind-${JACKSON_VERSION}.jar" | sha256sum -c -; \
  else \
    mkdir -p /tmp && touch /tmp/verapdf.zip /tmp/jackson-disabled.jar; \
  fi

# Outils PDF/A-3 (veraPDF) pour FACTURX_PDFA_MODE=strict.
FROM base AS pdftools
ARG VERAPDF_VERSION=1.28.2
ARG JACKSON_VERSION=2.18.9
ARG INSTALL_VERAPDF=true
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    zip \
    ca-certificates \
  && (apt-get install -y --no-install-recommends openjdk-17-jre-headless \
    || apt-get install -y --no-install-recommends openjdk-21-jre-headless) \
  && rm -rf /var/lib/apt/lists/*
COPY --from=verapdf-archive /tmp/verapdf.zip /tmp/verapdf.zip
COPY --from=verapdf-archive /tmp/jackson-*.jar /tmp/
RUN if [ "$INSTALL_VERAPDF" = "true" ]; then \
    rm -rf /opt/verapdf \
    && \
    unzip -q /tmp/verapdf.zip -d /tmp/verapdf \
    && printf "1\n/opt/verapdf\nO\n1\nY\nN\nN\n1\nN\n" | "/tmp/verapdf/verapdf-greenfield-${VERAPDF_VERSION}/verapdf-install" -console \
    && zip -q -d "/opt/verapdf/bin/greenfield-apps-${VERAPDF_VERSION}.jar" \
      'com/fasterxml/jackson/*' \
      'META-INF/maven/com.fasterxml.jackson.core/*' \
      'META-INF/versions/*/com/fasterxml/jackson/*' \
    && ! unzip -Z1 "/opt/verapdf/bin/greenfield-apps-${VERAPDF_VERSION}.jar" \
      | grep -Eq '^(com/fasterxml/jackson/|META-INF/maven/com\.fasterxml\.jackson\.core/|META-INF/versions/.*/com/fasterxml/jackson/)' \
    && install -m 0644 "/tmp/jackson-core-${JACKSON_VERSION}.jar" "/opt/verapdf/bin/" \
    && install -m 0644 "/tmp/jackson-annotations-${JACKSON_VERSION}.jar" "/opt/verapdf/bin/" \
    && install -m 0644 "/tmp/jackson-databind-${JACKSON_VERSION}.jar" "/opt/verapdf/bin/" \
    && ln -s /opt/verapdf/verapdf /usr/local/bin/verapdf \
    && rm -rf /tmp/verapdf /tmp/verapdf.zip /tmp/jackson-*.jar; \
  else \
    echo "Skipping veraPDF install (set INSTALL_VERAPDF=true to enable)."; \
  fi \
  && apt-get purge -y zip unzip \
  && rm -rf /var/lib/apt/lists/*
USER appuser

FROM pdftools AS app
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz', timeout=2).read()"

FROM app AS test
USER root
RUN pip install --no-cache-dir pytest
USER appuser
ENTRYPOINT []
CMD ["python", "-m", "pytest", "-q"]
