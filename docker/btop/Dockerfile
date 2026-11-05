# btop in the browser: ttyd serves a read-only terminal running btop.
# Started by `docker compose --profile btop up -d` (see docker-compose.example.yml);
# Pondering Orb's System tab shows it when Settings → btop terminal has its address.
FROM alpine:3.20
RUN apk add --no-cache btop ttyd
EXPOSE 7681
# ttyd is read-only unless -W is given, so viewers can't type into btop.
# BTOP_AUTH="user:password" turns on ttyd's basic sign-in.
CMD ["/bin/sh", "-c", "exec ttyd -p 7681 ${BTOP_AUTH:+-c \"$BTOP_AUTH\"} -t fontSize=13 -t titleFixed=btop btop"]
