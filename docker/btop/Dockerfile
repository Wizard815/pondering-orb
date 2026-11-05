# btop in the browser: ttyd serves a read-only terminal running btop.
# Started by `docker compose --profile btop up -d` (see docker-compose.example.yml);
# Pondering Orb's System tab shows it when Settings → btop terminal has its address.
FROM alpine:3.20
RUN apk add --no-cache btop ttyd
EXPOSE 7681
# ttyd is read-only unless -W is given, so viewers can't type into btop.
CMD ["ttyd", "-p", "7681", "-t", "fontSize=13", "-t", "titleFixed=btop", "btop"]
