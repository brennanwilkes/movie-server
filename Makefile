.PHONY: bootstrap deploy provision up down eject clean destroy validate ps logs mdns resize-data remount \
        search profiles history querylogs diagnose test why vpn-up vpn-off vpn-status
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
down:       ## stop & remove containers (keeps data + config; drive stays mounted)
	./scripts/teardown.sh stop
eject:      ## stop the stack + safely unmount the media drive (before a physical disconnect)
	./scripts/eject-data.sh
clean:      ## down + wipe app config (KEEPS media)
	./scripts/teardown.sh clean
destroy:    ## down + delete config, media AND images (guarded)
	./scripts/teardown.sh destroy
validate:   ## lint the compose file
	docker compose config -q && echo OK
resize-data: ## grow the $DATA loopback image to $DATA_IMG_SIZE (run 'make down' first)
	./scripts/resize-data.sh
remount:    ## re-mount the media drive at $DATA after a replug, then run 'make up'
	./scripts/ensure-data.sh
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

# --- Debug / introspection (read-only; answer "why did the algo pick THAT?") ---
search:     ## list available releases w/ custom-format SCORE (make search q="Pulp Fiction" [s=sonarr])
	./scripts/search-releases.sh --scores $(if $(filter sonarr,$(s)),--sonarr) "$(q)"
profiles:   ## dump live quality-profile scores per tier (make profiles [s=radarr|sonarr])
	./scripts/show-quality-profiles.sh $(s)
history:    ## show recent grab/import history (make history [a=--missing])
	./scripts/show-history.sh $(a)
querylogs:  ## tail/grep a service's logs (make querylogs s=radarr a='--grep grab')
	./scripts/query-logs.sh $(s) $(a)
diagnose:   ## full stack health check
	./scripts/diagnose.sh
test:       ## fast read-only PASS/FAIL assertions for the whole stack (run after any change)
	./scripts/smoke-test.sh
why:        ## why isn't this playing (well) on the PS4/projector? (make why q="Pulp Fiction")
	./scripts/why-playback.sh $(if $(filter sonarr,$(s)),--sonarr,--radarr) "$(q)"
metrics:    ## query time-series metrics (make metrics a='system --stats cpu' or a='events --type grab')
	./scripts/query-metrics.sh $(a)

# --- VPN (ProtonVPN via gluetun; routes ONLY qBittorrent) — see VPN.md ---
# vpn-up/off FORCE the topology for this run via env, so they work regardless of whether
# the COMPOSE_FILE/QBIT_HOST lines in .env are uncommented. Uncomment those to also make
# the VPN the default for plain `make up`/`deploy`.
vpn-up:     ## route qBittorrent through the ProtonVPN tunnel (deploy overlay + re-point *arr)
	@grep -qE '^VPN_WIREGUARD_PRIVATE_KEY=.+' .env || { echo "✗ set VPN_WIREGUARD_PRIVATE_KEY in .env first (see VPN.md)"; exit 1; }
	COMPOSE_FILE="docker-compose.yml:docker-compose.vpn.yml" QBIT_HOST=gluetun ./scripts/deploy.sh
	COMPOSE_FILE="docker-compose.yml:docker-compose.vpn.yml" QBIT_HOST=gluetun ./scripts/provision.sh qbittorrent radarr sonarr controller
vpn-off:    ## DEBUG ONLY: run qBittorrent direct (no VPN — real IP exposed); removes gluetun
	COMPOSE_FILE="docker-compose.yml" QBIT_HOST=qbittorrent ./scripts/deploy.sh
	COMPOSE_FILE="docker-compose.yml" QBIT_HOST=qbittorrent ./scripts/provision.sh qbittorrent radarr sonarr controller
vpn-status: ## show tunnel state: exit IP, location, forwarded port (via the controller API)
	@curl -s --max-time 8 "http://localhost:$${CONTROLLER_PORT:-8088}/api/vpn" | jq . 2>/dev/null \
	  || echo "controller or gluetun not reachable — is the VPN stack up? (make vpn-up)"
ps4ify:     ## convert a title's files to add AC3 compat track for PS4, quality untouched (make ps4ify q="Mormon Wives" [app=radarr])
	./scripts/ps4ify.sh $(if $(filter radarr,$(app)),--radarr) "$(q)"
