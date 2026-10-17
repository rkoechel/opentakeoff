# takeoff-vision waker

This starts the DGX Spark's `takeoff-vision` vLLM container when someone uses OpenTakeoff's AI. The container already stops itself after 15 minutes idle. This service does the reverse, and nothing else.

- `waker.py`: Python 3.8+ standard library only (no pip installs). It listens on **127.0.0.1:8012** by default.
- `GET /_waker/status` returns `{"state": "running"|"starting"|"stopped"|"no_memory", "freeGB": n}`.
  - **running:** the container is up and `HEALTH_URL` answers.
  - **starting:** the container is up (or a start is in flight), but the model isn't serving yet.
  - **stopped:** the container is stopped and there is enough memory to start it.
  - **no_memory:** the container is stopped and `MemAvailable` is below `MEM_THRESHOLD_GB`.
- `POST /_waker/wake` runs `docker start takeoff-vision`, and only when the container is stopped and memory allows.
  - Not enough memory: 503 `{"state":"no_memory"}`, and nothing is started.
  - Already running or starting: no action.
  - Only one start at a time; another wake while one runs gets `starting`.
  - No retry within `WAKE_COOLDOWN_S` (30 s) of the last start attempt; a wake in that window gets 429.
- Auth on both endpoints: `Authorization: Bearer $WAKER_TOKEN`, compared in constant time. Cloudflare Access sits in front with the same service token as the model.
- The container name is a constant. The request body and query are never used, no shell is invoked, and the token is never logged. Logs contain the method, path, status, and the memory numbers on a refusal.

OpenTakeoff's `/api/ai` proxy calls `/wake` once when the model is down, then polls `/status` (every 5 s, at most 3 min). While it waits, browsers see "Starting the takeoff AI… (usually ~1–2 min)" and retry on their own.

## Install on the Spark (Deployment, after Ryan approves)

None of these steps touches the existing containers, cloudflared's current rules, or ports 8000–8003.

1. **Check the facts first.**
   - `command -v docker` should print `/usr/bin/docker`. If it doesn't, adjust the sudoers file to the real path.
   - `docker inspect --format '{{.State.Status}}' takeoff-vision` shows the container.
   - `ss -ltn | grep -c ':8012 '` should print `0`, meaning the port is free.
   - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8010/health` gives 200 while the model is up.
2. **Create a service user with no login:**
   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin takeoff-waker
   ```
3. **Copy the files:**
   ```bash
   sudo install -d -m 0755 /opt/takeoff-vision-waker
   sudo install -m 0644 waker.py /opt/takeoff-vision-waker/waker.py
   sudo install -m 0644 takeoff-vision-waker.service /etc/systemd/system/takeoff-vision-waker.service
   ```
4. **Give the service user Docker permission. Choose one:**
   - **Recommended: a narrow sudoers rule.** It allows only `docker start takeoff-vision` and the one `docker inspect` of that container:
     ```bash
     sudo install -m 0440 takeoff-vision-waker.sudoers /etc/sudoers.d/takeoff-vision-waker
     sudo visudo -cf /etc/sudoers.d/takeoff-vision-waker
     ```
     Keep `WAKER_USE_SUDO=1` in the env file.
   - **Alternative: the docker group.** Run `sudo usermod -aG docker takeoff-waker`, set `WAKER_USE_SUDO=0`, and set `NoNewPrivileges=true` in the unit. The docker group is root-equivalent, so the sudoers rule is safer.
5. **Write the env file.** The value of `WAKER_TOKEN` is a secret. Generate it on the Spark and never paste it into chat:
   ```bash
   sudo install -m 0640 -g takeoff-waker takeoff-vision-waker.env.example /etc/takeoff-vision-waker.env
   sudoedit /etc/takeoff-vision-waker.env   # set WAKER_TOKEN=$(openssl rand -hex 32); MEM_THRESHOLD_GB=17
   ```
   - If cloudflared does **not** run on the Spark (it reaches the model at `100.72.198.58:8010`), set `WAKER_HOST=100.72.198.58`. That keeps the waker on the tailnet address only, never `0.0.0.0`.
6. **Start the service:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now takeoff-vision-waker
   journalctl -u takeoff-vision-waker -n 20
   ```
7. **Add one cloudflared ingress rule.** It goes in the existing tunnel's `config.yml`, directly **above** the current `takeoff-vision.floor360.com` rule. It's an addition only; don't edit or remove the existing rule:
   ```yaml
     - hostname: takeoff-vision.floor360.com
       path: ^/_waker/
       service: http://127.0.0.1:8012        # or http://100.72.198.58:8012 if cloudflared is off-box
   ```
   - For a dashboard-managed tunnel, add a public hostname `takeoff-vision.floor360.com` with path `_waker/*` and service `http://127.0.0.1:8012` (or the tailnet address), ordered above the existing one.
   - Then restart cloudflared, or let the dashboard push the change.
   - The Cloudflare Access app on `takeoff-vision.floor360.com` must cover `/_waker/*`, which it does if it protects the whole hostname. Reuse the same service token.
8. **App Service settings for OpenTakeoff:**
   - `AI_WAKER_URL=https://takeoff-vision.floor360.com/_waker`
   - `WAKER_TOKEN` as a Key Vault reference holding the same value as on the Spark.
   - `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` are already set for the model.
9. **Check it** (from the Spark, with the token in a shell variable, not on the command line history of a shared account):
   ```bash
   curl -s -H "Authorization: Bearer $WAKER_TOKEN" http://127.0.0.1:8012/_waker/status
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8012/_waker/status                         # 401
   ```

**Uninstall:** run `systemctl disable --now takeoff-vision-waker`, then remove the unit, the env file, the sudoers file, `/opt/takeoff-vision-waker`, the user, and the one ingress rule.

## Tests

`python3 -m unittest -q test_waker` in this directory. `web/test/takeoffVisionWaker.test.ts` runs it inside `npm test`.
