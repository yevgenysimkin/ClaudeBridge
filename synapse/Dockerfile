FROM matrixdotorg/synapse:latest

# Copy config templates — entrypoint substitutes env vars at runtime
COPY homeserver.yaml /conf/homeserver.yaml.template
COPY log.config /conf/log.config
COPY docker-entrypoint.sh /docker-entrypoint.sh

RUN chmod +x /docker-entrypoint.sh

EXPOSE 8008

ENTRYPOINT ["/docker-entrypoint.sh"]
