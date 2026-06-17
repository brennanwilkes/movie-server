.PHONY: bootstrap deploy provision up down clean destroy validate ps logs
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
ps:
	docker compose ps
logs:       ## tail logs (make logs s=radarr)
	docker compose logs -f --tail=100 $(s)
