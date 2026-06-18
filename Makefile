.PHONY: bootstrap deploy provision up down clean destroy validate ps logs mdns
bootstrap:  ## one-time host prep (dirs, cap, .env, hook)
	./scripts/bootstrap.sh
deploy:     ## validate + pull + start (make deploy s=jellyfin for one)
	./scripts/deploy.sh $(s)
# 'make provision s=controller' discovers all API keys into
# /opt/appdata/controller/keys.env and restarts the dashboard container.
provision:  ## apply config-as-code via each app's API (make provision s=radarr for one)
	./scripts/provision.sh $(s)
up:         ## deploy + provision the whole stack (idempotent)
	./scripts/deploy.sh && ./scripts/provision.sh
down:       ## stop & remove containers (keeps data + config)
	./scripts/teardown.sh stop
clean:      ## down + wipe app config (KEEPS media)
	./scripts/teardown.sh clean
destroy:    ## down + delete config, media AND images (guarded)
	./scripts/teardown.sh destroy
validate:   ## lint the compose file
	docker compose config -q && echo OK
mdns:       ## (re)publish $MDNS_NAME (e.g. movies.local movie.local) on the LAN, persistent (asks for sudo)
	chmod +x scripts/mdns-publish.sh
	sudo install -m644 scripts/movie-mdns.service /etc/systemd/system/movie-mdns.service
	sudo systemctl daemon-reload
	sudo systemctl enable movie-mdns.service
	sudo systemctl restart movie-mdns.service   # restart so it re-reads MDNS_NAME after changes
	@echo "Published. Re-run this after editing MDNS_NAME in .env."
ps:
	docker compose ps
logs:       ## tail logs (make logs s=radarr)
	docker compose logs -f --tail=100 $(s)
