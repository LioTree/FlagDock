ARG BASE_IMAGE=flagdock-sandbox-base:latest
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm

RUN apt-get update \
    && apt-get install -y curl ca-certificates gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && npm install -g opencode-ai@1.14.31 \
    && mkdir -p /root/.config/opencode /root/.local/share/opencode /root/.opencode/agent /challenge \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /challenge
EXPOSE 4096

CMD ["opencode", "web", "--hostname", "0.0.0.0", "--port", "4096"]
