# Deployment

Every push to `main` runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which
verifies the repo and then `rsync`s it onto the server over SSH. There is nothing to build, so a
deploy is just a file copy — typically a couple of seconds.

The workflow does two things:

1. **Verify** — regenerates the agent files and fails if the committed copies are stale, checks
   that all JavaScript parses, and validates `data/events.json`. This runs on every push.
2. **Deploy** — copies the site to the server with `rsync --archive --delete`, then optionally
   smoke-tests the live URL.

The deploy job is skipped (not failed) while `DEPLOY_HOST` is unset, so the repo is safe to push
to before the server exists.

## What gets deployed

Everything except the repo's own scaffolding. `README.md`, `CLAUDE.md`, `DEPLOYMENT.md`,
`tools/`, `deploy/`, `.github/` and `.git/` are excluded, leaving exactly the ten files the site
serves:

```
index.html  css/styles.css  js/main.js  data/events.json
llms.txt  robots.txt  sitemap.xml
dlc/index.html  dlc/css/styles.css  dlc/js/main.js
```

`--delete` means files removed from the repo are removed from the server too, so the web root is
an exact mirror of `main`. That also makes a wrong `DEPLOY_PATH` destructive, which is why the
workflow refuses empty and top-level paths before running.

---

## One-time setup

### 1. On the server — create a deploy user and the web root

```sh
sudo useradd --create-home --shell /bin/bash deploy

sudo mkdir -p /var/www/cazp
sudo chown -R deploy:www-data /var/www/cazp
sudo chmod -R 755 /var/www/cazp
```

The `deploy` user only needs write access to that one directory — it does not need sudo.

#### Using a different directory, e.g. `/srv/cazp`

Nothing hardcodes `/var/www/cazp` — the location is the `DEPLOY_PATH` variable. To serve from
`/srv/cazp` instead, change it in four places:

```sh
sudo mkdir -p /srv/cazp
sudo chown -R deploy:www-data /srv/cazp
sudo chmod -R 755 /srv/cazp

gh variable set DEPLOY_PATH --body '/srv/cazp'    # step 3 below
```

plus `root /srv/cazp;` in the nginx block, and the path inside `rrsync -wo ...` if you use the
optional hardening. The workflow refuses bare system directories, so `/srv` on its own is
rejected while `/srv/cazp` is accepted.

**If the server runs SELinux (RHEL, Fedora, Rocky, Alma), `/srv` needs one extra step.**
`/var/www` ships pre-labelled as web content; `/srv` does not, so nginx gets a permission error
reading files whose Unix permissions look perfectly correct. Check with `getenforce`, and if it
says `Enforcing`:

```sh
sudo semanage fcontext -a -t httpd_sys_content_t "/srv/cazp(/.*)?"
sudo restorecon -Rv /srv/cazp
ls -Zd /srv/cazp        # should now show httpd_sys_content_t
```

(`semanage` lives in the `policycoreutils-python-utils` package.) Debian and Ubuntu use AppArmor
instead, whose default nginx profile does not restrict document roots, so `/srv` works there
without any of this. Either way `/srv` itself must stay traversable — `chmod 755 /srv` — or the
web server cannot descend into it.

### 2. On your machine — create a deploy key

A dedicated key, with **no passphrase** (GitHub Actions cannot type one):

```sh
ssh-keygen -t ed25519 -C "github-actions-cazp" -f ~/.ssh/cazp_deploy -N ""
```

That writes two files. They go to opposite places:

| File | Contents | Destination |
| --- | --- | --- |
| `~/.ssh/cazp_deploy.pub` | public half, a single line | the **server** |
| `~/.ssh/cazp_deploy` | private half | the **`DEPLOY_SSH_KEY` GitHub secret** |

`authorized_keys` is the list of public keys allowed to log in as a given user — one key per
line, each line optionally prefixed with comma-separated options. Prepare the file first
(`sshd` ignores it entirely if the permissions are too loose):

```sh
# on the server, as a user with sudo
sudo -u deploy mkdir -p /home/deploy/.ssh
sudo -u deploy chmod 700 /home/deploy/.ssh
sudo -u deploy touch /home/deploy/.ssh/authorized_keys
sudo -u deploy chmod 600 /home/deploy/.ssh/authorized_keys
```

Then append the key from your machine. This prepends the literal word `restrict` to the
unchanged contents of the `.pub` file, so there is nothing to copy by hand:

```sh
{ printf 'restrict '; cat ~/.ssh/cazp_deploy.pub; } \
  | ssh YOU@YOUR.SERVER 'sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys'
```

The resulting line looks like this — the `.pub` file's own line, with one word in front:

```
restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID... github-actions-cazp
```

`restrict` is a deny-by-default switch: no port forwarding, no agent forwarding, no X11, no PTY,
no user rc file. Since the private key sits in GitHub secrets, this limits what a leak is worth.

Be clear about the limit, though: **`restrict` does not prevent arbitrary commands.** It blocks
an interactive shell and tunnelling, but `ssh deploy@host 'some command'` still runs — that is
exactly how rsync works over SSH, so it cannot be blocked without breaking the deploy. To lock
the key down to rsync alone, see [Optional hardening](#optional-hardening) below.

Check it works before involving GitHub:

```sh
rsync -n -av -e "ssh -i ~/.ssh/cazp_deploy" ./index.html deploy@YOUR.SERVER:/var/www/cazp/
```

### 3. Register the credentials with GitHub

Run these from this directory — `gh` is already authenticated as `ZBager`:

```sh
# Secrets — genuinely sensitive
gh secret set DEPLOY_SSH_KEY < ~/.ssh/cazp_deploy
ssh-keyscan YOUR.SERVER | gh secret set DEPLOY_KNOWN_HOSTS

# Variables — not sensitive, and visible in logs makes failures easier to read
gh variable set DEPLOY_HOST --body 'YOUR.SERVER'
gh variable set DEPLOY_USER --body 'deploy'
gh variable set DEPLOY_PATH --body '/var/www/cazp'

# Optional
gh variable set DEPLOY_PORT --body '22'                                  # only if not 22
gh variable set SITE_URL    --body 'https://czyacerixxznalazlprace.pl'   # enables the smoke test
```

`DEPLOY_KNOWN_HOSTS` pins the server's host key, so the workflow uses
`StrictHostKeyChecking=yes` rather than blindly trusting whatever answers on first connection.
If you ever rebuild the server, re-run the `ssh-keyscan` line or deploys will fail with a host
key mismatch — which is the point.

### 4. Deploy

```sh
gh workflow run Deploy      # or just push to main
gh run watch
```

---

## Web server

Skip this if the box already serves the site. Minimal nginx:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name czyacerixxznalazlprace.pl www.czyacerixxznalazlprace.pl;

    root /var/www/cazp;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    # CSS and JS filenames are not fingerprinted, so a long max-age would
    # serve stale assets after a deploy. Revalidate instead.
    location ~* \.(css|js|json|txt|xml)$ {
        add_header Cache-Control "no-cache";
    }
}
```

Then TLS:

```sh
sudo certbot --nginx -d czyacerixxznalazlprace.pl -d www.czyacerixxznalazlprace.pl
```

Two things this site needs that are easy to get wrong:

- **`/data/events.json` must be reachable.** The page fetches it at runtime; if it 404s the
  comparison section falls back to the static summary. The smoke test in the workflow checks it.
- **`/dlc/` needs the trailing slash** to resolve `dlc/css/styles.css` correctly. `try_files
  $uri $uri/` handles the redirect.

---

## The terminal answer (Cloudflare Worker)

```sh
$ curl czyacerixxznalazlprace.pl
Nie.
```

That answer does not come from nginx. The site is proxied by Cloudflare, and a small Worker
answers the root path for terminal HTTP clients before the request ever reaches the origin.
Everything else — browsers, search crawlers, AI agents, every path other than `/` — falls
through to the origin untouched and still gets the full HTML with its static summary.

The script is [`deploy/worker.mjs`](deploy/worker.mjs). It is **not** copied by the rsync deploy
(`deploy/` is in the exclude list); the repo holds the canonical copy and the edge holds a paste
of it. It decides, in this order:

1. **`Accept` contains `text/html` → the page.** Browsers are excluded before any User-Agent
   sniffing happens. This is also the escape hatch when debugging:
   `curl -H 'Accept: text/html' czyacerixxznalazlprace.pl` returns the real HTML.
2. **A terminal User-Agent (`curl`, `Wget`, `HTTPie`, `xh`, `lwp-request`) asking for `/` with
   `GET` or `HEAD` → `Nie.`** in `text/plain`, or `No.` if the request carries
   `Accept-Language: en`. Nothing else matches: `/data/events.json`, `/llms.txt` and `/dlc/`
   behave exactly as before for every client.
3. **Anything else → the origin.** The user-agent list is a whitelist and deliberately narrow —
   `python-requests`, `Go-http-client`, `node-fetch` and friends are how bots and AI assistants
   fetch the page, and they are supposed to receive the static summary, not four bytes.

### Why the Worker also does the HTTPS redirect

`curl example.com` does not follow redirects, so before this existed the bare command printed an
empty body: port 80 answered with a `301` and curl showed nothing. The Worker therefore has to be
reached on `http://` too, which is why its routes are written without a scheme.

Measured on this zone, the Worker runs **before** Cloudflare's Always Use HTTPS, so that setting
can stay on — it never gets the chance to pre-empt the terminal answer. It is a backstop, not the
thing doing the work: the `301` a browser receives on `http://` comes from the Worker's own
redirect (note the absent `content-type`, which Cloudflare's built-in redirect does send). The
Worker redirects every `http://` request except the one case above, so nothing but the four-byte
answer is ever served over plain HTTP.

HSTS is untouched for the clients that can act on it. `strict-transport-security` comes from
Cloudflare's edge certificate settings and still rides on the HTML response; it is absent only
from the Worker's synthetic plain-text reply, which no browser ever sees — and curl ignores HSTS
regardless. Check it the way a browser would, or you will be reading the Worker's headers and
conclude it has vanished:

```sh
curl -sI -H 'Accept: text/html' https://czyacerixxznalazlprace.pl/ | grep -i strict-transport
```

### Deploying it

By hand, in the Cloudflare dashboard — no `wrangler`, no `npm`, in keeping with the rest of the
repo. Workers → Create → paste `deploy/worker.mjs` → Deploy, then add two routes (leave the
scheme off, so they match both `http` and `https`):

```
czyacerixxznalazlprace.pl/*
www.czyacerixxznalazlprace.pl/*
```

Cloudflare **Snippets** runs the same code from the dashboard if Workers routes are not available
on the plan.

Watch the route patterns: a leading `*.` matches **subdomains only**, so
`*.czyacerixxznalazlprace.pl/*` silently skips the apex — the one address people actually type.
Write the hostname plainly, as above.

Also turn **off** the `workers.dev` routes under Domains & Routes. Otherwise the Worker is
reachable at `<name>.<account>.workers.dev`, where a browser request makes it `fetch()` its own
hostname — a subrequest loop.

Then verify, before and after:

1. `curl https://czyacerixxznalazlprace.pl/` prints `Nie.`, a browser still gets the site, and
   `/data/events.json` is still JSON.
2. `curl czyacerixxznalazlprace.pl` — no scheme, no `-L` — prints `Nie.`, while
   `curl -sI -H 'Accept: text/html' czyacerixxznalazlprace.pl` is still a `301` to `https://`.
3. Turn the checks on for future deploys: `gh variable set CURL_ANSWER --body 'true'`.

**Rolling back needs no deploy.** Remove the Worker routes and everything reverts to the previous
behaviour immediately — Always Use HTTPS resumes handling port 80. Unset `CURL_ANSWER` so the
smoke test stops expecting the answer.

### The smoke test guards it

Because the Worker is deployed by hand, the repo and the edge can drift. The workflow's smoke
test therefore asserts the *live behaviour* on every deploy — that `curl` gets `Nie.` on both
schemes, that `Accept: text/html` still returns the page with its static summary, that browsers
on `http://` still get a `301` to HTTPS, and that HSTS is still being sent. Those checks only run
when the `CURL_ANSWER` repository variable is `true`, so the repo can be pushed before the Worker
exists without turning the build red.

---

## Operating it

**Watch a deploy**

```sh
gh run list --workflow=Deploy --limit 5
gh run watch
gh run view --log-failed        # after a failure
```

**Roll back** — deploys mirror `main`, so reverting the commit reverts the site:

```sh
git revert HEAD && git push
```

**Deploy without a code change** (e.g. after fixing a server-side problem):

```sh
gh workflow run Deploy
```

### Troubleshooting

| Symptom | Cause |
| --- | --- |
| Deploy job skipped entirely | `DEPLOY_HOST` variable is unset |
| `Host key verification failed` | `DEPLOY_KNOWN_HOSTS` is stale or missing — re-run `ssh-keyscan` |
| `Permission denied (publickey)` | Public key not in `/home/deploy/.ssh/authorized_keys`, or the file's permissions are not `600` |
| `rsync: failed to set permissions` | `deploy` does not own `DEPLOY_PATH` — re-run the `chown` |
| Deploy succeeds but the site 403s | SELinux label missing on a non-`/var/www` root — see "Using a different directory" above |
| `DEPLOY_PATH ... is a system directory` | You pointed it at `/srv` or `/var` rather than the site's own subdirectory |
| `mkdir "/srv/cazp/srv/cazp" failed` (path doubled) | The key uses `rrsync` but `DEPLOY_RRSYNC` is not set to `true` — see "Optional hardening" below |
| `curl` prints HTML instead of `Nie.` | The Worker route came off, or the request carried `Accept: text/html` |
| `curl` prints nothing over `http://` | Cloudflare's Always Use HTTPS is back on — it pre-empts the Worker |
| Smoke test fails only on the terminal-answer checks | The Worker is gone or stale while `CURL_ANSWER` is still `true` |
| Verify fails on "Generated files are stale" | You edited `data/events.json` without running `node tools/build-agent-files.mjs`; run it and commit |
| Site serves old CSS after a deploy | Browser or CDN cache — see the `Cache-Control` block above |

### Optional hardening

To restrict the deploy key so it can *only* rsync into the web root — not run arbitrary
commands — use `rrsync` (ships with rsync) in the `authorized_keys` line:

```
restrict,command="rrsync -wo /var/www/cazp" ssh-ed25519 AAAA... github-actions-cazp
```

Check where your distro puts it first (`command -v rrsync` or
`/usr/share/rsync/scripts/rrsync`) and use the full path if it is not on `PATH`.

**This also requires a repository variable**, because `rrsync` resolves incoming paths
*relative to* the root in its own command line. Sending the absolute `DEPLOY_PATH` on top of
that would write the site to `/var/www/cazp/var/www/cazp`, so tell the workflow that the
server already pins the destination:

```sh
gh variable set DEPLOY_RRSYNC --body 'true'
```

With that set, the workflow sends to the rrsync root itself and does not use `DEPLOY_PATH` —
the `authorized_keys` line becomes the single place the web root is defined, and the
system-directory guard is left to the server. `DEPLOY_PATH` stays useful as documentation and
for the nginx `root`, but changing it alone will no longer move the deployment. Leave
`DEPLOY_RRSYNC` unset for a plain deploy key.
