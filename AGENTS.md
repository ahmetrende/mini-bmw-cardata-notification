# Guide for AI coding agents

This file is for an AI tool that helps a person set up or change this project. Read it before you run any command.

The project sends a phone notification when a door, window, sunroof, trunk or hood of a MINI or BMW stays open. A small program runs on a server and reads the BMW CarData stream.

Human guides: [README.md](README.md) (English) and [README.tr.md](README.tr.md) (Turkish). The full setup is in `docs/en/` and `docs/tr/`. Follow those guides step by step. This file adds rules and warnings.

## Rules that always apply

1. **Never ask for or type a password, a card number or a one-time code.** The person types them. If a login page asks for a password, stop and tell the person.
2. **Never print a secret in the chat or in a log.** Secrets: `tokens.json`, the ID token, the access token, the refresh token. Treat the Client ID, the ntfy topic name, the VIN and the server IP address as private too. Do not put them in a commit.
3. **Never commit `config.json` or `tokens.json`.** `.gitignore` blocks them. Do not change that rule.
4. **Ask before you do any of these:** create a billing account, link billing, create or delete a cloud resource, accept terms, or approve a permission. Name the cost and the effect in your question.
5. **Do not accept terms for the person.** The person reads and accepts the Google terms and the MINI CarData terms.
6. **Write the country name as "Türkiye"** in every language, also in English text.

## Who does which step

| Step | Guide | Agent | Person |
|---|---|---|---|
| Turn on CarData and create a Client ID | `02-cardata-portal` | Only with a browser tool, and only after the person logs in | Logs in, accepts terms, presses the switches |
| Install the ntfy app | `03-ntfy` | Makes a random topic name | Installs the app and subscribes |
| Google Cloud account and billing | `04-server-setup`, part 1 | None | Signs up and enters the card |
| `gcloud` login | `04-server-setup`, part 2 | Starts the command | Selects the account and approves in the browser |
| Project, budget alert, server, firewall | `04-server-setup`, parts 3 to 5 | Runs the commands, after the person agrees to the cost | Agrees |
| Install the program | `04-server-setup`, part 6 | Runs `deploy/install.sh`, edits `config.json` | Gives the Client ID and the topic name |
| Log in to the car account | `04-server-setup`, part 7 | Runs the `login` command, shows the code | Approves the code in the browser |
| Start and test | `04-server-setup`, parts 8 and 9 | Starts the service, reads the log | Does the real test with the car |

## Checks that show you finished a step

| After | Check |
|---|---|
| Portal | **Configuration status** shows **ready**. The Client ID exists. |
| Server | `gcloud compute instances list` shows `RUNNING`. |
| Firewall | `gcloud compute ssh ... --tunnel-through-iap` works. A connection to port 22 from the internet fails. |
| Install | `sudo bash deploy/install.sh` ends with "Install done." |
| Login | The log line "Login done. Granted scope:" has `cardata:streaming:read`. |
| Service | The log shows "Connected to the stream." and "Subscribed: qos0". |
| Notification | `sudo mini-watch ntfy-test` puts a message on the phone. |
| Whole setup | `sudo mini-watch doctor` shows no `FAIL` line. It sends nothing. |
| Car | After the car sends data, the log shows `Message: vehicle...` lines. |

## Known traps

- **Close the public firewall rules last.** Create the IAP rule. Test `--tunnel-through-iap`. Then delete `default-allow-ssh`, `default-allow-rdp` and `default-allow-icmp`. If you delete first, you lose access to the server.
- **A small server can stop to answer when its memory is full.** On 2026-10-07 an old memory leak and a replay on the server filled the 953 MB of an e2-micro server. SSH did not answer. The service now has `MemoryMax=250M` and `install.sh` adds a 1 GB swap file. Still, run long tools on another computer.
- **Do not reset the server with a hard reset** (`gcloud compute instances reset`, or the console **Reset** button). Files that you wrote a moment before can become empty. Use `sudo systemctl reboot`. Run `sync` after you copy files.
- **One stream connection for each account.** A second copy of the program with the same account breaks both. Do not run the program on the person's own computer when the server runs it.
- **Subscribe before you log in.** Turn on **CarData API**, wait 60 seconds, turn on **CarData Stream**, wait 60 seconds. Then run the `login` command. A login before the subscription gives a token without the stream scope.
- **Do not press "Authenticate device" in the portal before the program shows a code.**
- **The portal list page loses the old selection** if you open it from the address bar. Use the **Change data selection** button. The first press can fail. Press it again.
- **macOS system Python cannot connect to the stream.** The broker needs TLS 1.3. This project uses Node 22 or newer.
- **A restart can send a wrong notification.** After a restart, an empty list of open parts can mean "no data yet". The program handles this. Still, before you restart a running server, do a dry run (see below).
- **The car sends data only when something changes.** An asleep car sends nothing. A remote light signal or an open and close of a door wakes the data.
- **Server paths.** The code is in `/opt/mini-watch/releases/<date>-<commit>` and belongs to root. `/opt/mini-watch/current` points to the release in use. Settings and data are in `/var/lib/mini-watch` (mode 0700, user `miniwatch`). The log is in the system journal: `sudo journalctl -u mini-watch`. Use `sudo mini-watch login`, `sudo mini-watch ntfy-test` and `sudo mini-watch doctor`. Do not start a second copy with `run`.
- **Update and rollback.** `sudo bash deploy/install.sh` checks the new release, switches, and waits for `Subscribed`. Without it, the script goes back to the release before. `sudo bash deploy/install.sh --rollback` goes back by hand.
- **The tested car (MINI Countryman E, U25) sends no ignition, motion or speed data.** It sends the central lock (`vehicle.cabin.door.status`: `UNLOCKED`, `LOCKED` while it drives, `SECURED` after a lock from outside). It does not send `alarm.armStatus`. Do not promise more. Another car can differ.

## Change the code

1. Run `npm ci` and `npm test`. All tests must pass. The tests use fake data and need no account. GitHub Actions runs the same tests for each push (`.github/workflows/test.yml`). `test/docs.test.mjs` fails when the English and Turkish guides have a different structure.
2. Keep comments and log lines in English. Notification text lives in the `TEXT` table in `mini_watch.mjs`. Add each new text in both languages (`en` and `tr`).
3. Docs: English follows ASD-STE100 (short sentences, one instruction in each sentence, no semicolons, active voice). Turkish uses plain, natural technical Turkish. Change both languages together. Keep the two guides equal in content.
4. Do not add personal data to the repository: no real Client ID, topic name, VIN, IP address, project name, e-mail address or token. Use placeholders such as `1a2b3c4d-1111-2222-3333-444455556666`.
5. Before you commit, search the staged files for private data:

```bash
git grep --cached -nIE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|WMW[A-Z0-9]{14}|eyJ[A-Za-z0-9_-]{20,}\.|/Users/|@gmail\.com'
```

Only the placeholder values may appear in the result.

## Dry run before you restart or update a running server

A dry run shows which notifications the program would send. It sends nothing. Use `tools/replay.mjs`:

```bash
node tools/replay.mjs messages.jsonl config.json --hours 24
```

The tool replays the saved messages with a virtual clock and prints each notification with its time. Check that the output matches what the person expects. Only then restart the service.

The free e2-micro server has a small CPU. Copy `/var/lib/mini-watch/messages.jsonl` to another computer (`sudo cat` over SSH) and run the replay there. The file contains the VIN. Delete the copy when you are done. Do not run a long replay on the live server. A busy server can stop the SSH connection.

## Short summary in Turkish

Bu dosya, projeyi kurmaya yardım eden bir yapay zekâ aracı içindir. Kurulum rehberleri `docs/tr/` içinde.

- Parola, kart numarası ve tek kullanımlık kodu asla sen yazma. Kullanıcı yazar.
- Token, Client ID, konu adı, VIN ve IP adresini sohbete veya commit'e yazma.
- Ücret doğuran veya şart kabul eden bir işten önce kullanıcıya sor.
- Güvenlik duvarındaki genel kuralları, IAP tünelini denemeden silme.
- Sunucuyu sert sıfırlama. `sudo systemctl reboot` kullan.
- Aynı MINI hesabıyla programı iki yerde çalıştırma.
- Çalışan sunucuyu yeniden başlatmadan önce `tools/replay.mjs` ile hangi bildirimlerin gideceğini gör. Bunu sunucuda değil, başka bir bilgisayarda yap.
- Ülke adını "Türkiye" yaz.
