# Step 4 of 5: Run and update the program

[Türkçe](../tr/05-isletim.md) · [README](../../README.md)

Run all commands on the server. To connect:

```bash
gcloud compute ssh cardata-server --zone=us-central1-a --tunnel-through-iap
```

## Daily commands

| Task | Command |
|---|---|
| Status | `systemctl status mini-watch --no-pager` |
| Live log | `sudo journalctl -u mini-watch -f` |
| Log without message lines | `sudo journalctl -u mini-watch -n 500 --no-pager \| grep -v "Message:" \| tail -30` |
| Sent notifications | `sudo journalctl -u mini-watch --no-pager \| grep -E "Notification (sent\|accepted)" \| tail -20` |
| Restart | `sudo systemctl restart mini-watch` |
| Stop | `sudo systemctl stop mini-watch` |
| Test notification | `sudo mini-watch ntfy-test` |
| Check if ntfy still has a notification (sends nothing) | `sudo mini-watch ntfy-check <id>`. The message id is in the log line `Notification accepted by ntfy`. |
| Test notification through Pushover (sends a real notification, also while `notify_service` is `ntfy`) | `sudo mini-watch pushover-test`. See [Pushover](06-pushover.md). |
| Check the setup (sends nothing) | `sudo mini-watch doctor` |

To watch the log from your computer with one command:

```bash
gcloud compute ssh cardata-server --zone=us-central1-a --tunnel-through-iap --command='sudo journalctl -u mini-watch -f'
```

## Log lines

| Line | Meaning |
|---|---|
| `Connected to the stream.` and `Subscribed: qos0` | The connection is good. |
| `Message: vehicle....` | Data arrived from the car. |
| `Notification accepted by ntfy: ...` | ntfy accepted a notification. The line has the title, the text, the message id, the HTTP status, the time and the expiry time (UTC). The time and the expiry time show only when ntfy sends valid values. "Accepted" means that ntfy stored the message. It does not mean that the phone got it. ntfy gives no delivery confirmation. Older log lines say `Notification sent: ...`. They have no HTTP status, no time and no expiry time. To list all sent notifications: `sudo journalctl -u mini-watch --no-pager \| grep -E "Notification (sent\|accepted)"`. |
| `Notification not confirmed: ...` | ntfy answered with HTTP 2xx, but the answer has no message id. The program does not count the notification as sent. It tries again later, as after `Notification failed`. If the line repeats, check `ntfy_server` in `config.json`. |
| `Notification service: Pushover.` | The program started with `notify_service` set to `pushover`. With ntfy, this line does not show. See [Pushover](06-pushover.md). |
| `Notification accepted by Pushover: ...` | Pushover accepted a notification. The line has the title, the text, the request id and the HTTP status. It is not a delivery confirmation. |
| `Notification not confirmed by Pushover: ...` | Pushover answered with HTTP 2xx, but the answer has no request id. The program does not count the notification as sent. It tries again later, as after `Notification failed`. |
| `The token expires soon. Refreshing it.` | The normal refresh. It happens each hour. |
| `Reconnecting in 5 seconds.` | The connection closed. The program reconnects. You see this line each hour after a token refresh. |
| `MQTT error: Keepalive timeout` | A network break. It is normal when rare. If it is frequent, check the network. |
| `Could not refresh the token ...` | You must log in again. See below. |
| `Notification failed: ...` | ntfy was not reachable, or it answered with an HTTP error. The first retry comes after about 30 seconds. The base wait doubles with each failure and stops at 10 minutes. The program adds a random change of up to 20 percent, so the longest wait is about 12 minutes. Before a retry, the program checks again if the notification is still necessary. The notification about missing car data waits a fixed 10 minutes. With ntfy, if the line repeats, check the topic name and the network. With Pushover, the same retry rules apply. A network error then shows as `Notification failed: no answer from Pushover (...)` or `Notification failed: no answer from Pushover in 15 seconds`. If the line repeats with Pushover, check the keys and the connection with `sudo mini-watch doctor`. |
| `Subscribe error: ... Reconnecting.` | The stream refused the subscription. The program connects again. If the line repeats, make sure that **CarData Stream** is on in the portal. |
| `The history file is full. ...` | `messages.jsonl` reached 10 MB and became `messages.jsonl.1`. This is normal. |
| `A stream message was skipped: ...` | The message was too large (more than 64 KB). The program did not store it. |
| `Unknown value "..." for ...` | The car sent a value that the program does not know. The part keeps its last state. Please open an issue and add this line. |
| `Set "ntfy_topic" ...`, `Set "pushover_token" ...` or `"..." must be a number of minutes ...` | The program did not start. A value in `config.json` is wrong. Correct it and restart the service. |

## Change a setting

```bash
sudo nano /var/lib/mini-watch/config.json
sudo systemctl restart mini-watch
```

| Field | Default | Meaning |
|---|---|---|
| `language` | `en` | Language of the notification text: `en` or `tr` |
| `timezone` | server time zone | Time zone of the times in the notification. Example: `Europe/Istanbul` |
| `alert_after_min` | 10 | Wait time after the last driver door opening, before a notification |
| `alert_after_lock_min` | 0 | Wait time after you lock the car from outside, for a part that was open at the lock. 0 = at once. Use 1 if you close the windows with the lock button. |
| `remind_after_min` | `[30, 90]` | Reminders, in minutes after the first notification. `[]` = no reminder. Up to 10 values, each larger than the one before. |
| `park_after_idle_min` | 30 | The car counts as parked when the odometer is still for this time |
| `ntfy_tags` | see below | The emoji at the start of the title, one ntfy tag name for each kind: `open`, `still_open`, `closed`, `locked`, `silence`, `test`. Defaults: `warning` (⚠️), `warning`, `white_check_mark` (✅), `lock` (🔒), `grey_question` (❔), `car` (🚗). Example: `{"open": "rotating_light"}`. A missing kind keeps its default. The names are in [the ntfy emoji list](https://docs.ntfy.sh/emojis/). |
| `notify_trip` | `false` | `true` = the length of the last drive at the end of the first notifications (not the reminders), in parentheses. Example: `(drive 23 min)`. It shows only when the odometer rose since the last notification with details (after a drive). |
| `notify_battery` | `false` | `true` = the battery level and the range at the end of the first notifications (not the reminders), in parentheses. Example: `(battery 64%, range 187 km)`. The attributes must be in the stream. Same rule as `notify_trip`: only after a drive. The charging state is an exception: it shows always. |
| `notify_battery_below_pct` | 100 | A number from 1 to 100. The battery level and the range show only when the level is below this percent. Example: `30` shows them only below 30%. 100 = always. Only with `notify_battery` on. The limit does not apply while the car charges. |
| `lock_confirm` | `false` | `true` = a message "locked, everything is closed" when you lock the car and all parts are closed. It shows that the system works. |
| `silence_alert_hours` | 0 (off) | One notification when the car sends no data for this many hours. The car sends nothing while it sleeps, so a long parked time also gives this notification. |
| `vehicle_names` | `{}` | Names for the cars of an account with more than one car. Example: `{"VIN-OF-CAR-1": "Countryman"}` |
| `ntfy_server` | `https://ntfy.sh` | The address of your own ntfy server |
| `notify_service` | `ntfy` | The service for all notifications: `ntfy` or `pushover`. See [Pushover](06-pushover.md). |
| `pushover_token` | empty | The API token of your Pushover application (30 letters and digits). Secret. Only used with `pushover` and by `pushover-test`. |
| `pushover_user` | empty | Your Pushover user key or a delivery group key (30 letters and digits). Secret. Only used with `pushover` and by `pushover-test`. |

## Update the program

1. Connect to the server.
2. Run:

```bash
cd ~/mini-bmw-cardata-notification
git pull
sudo bash deploy/install.sh
```

The script does these steps:

1. It installs the new version in a new folder in `/opt/mini-watch/releases`. The running service does not use it yet.
2. It checks the new version with your settings (`doctor --offline`). If a check fails, nothing changes.
3. It switches to the new version and restarts the service.
4. It waits up to 2 minutes for `Subscribed`. If the line does not come, it goes back to the version before.

The script does not change `config.json` or `tokens.json`. It keeps the 3 newest versions. An older install kept the code and the data in `/opt/mini-watch`. The script moves them one time. The old `run.log` becomes `/var/lib/mini-watch/run-before-journal.log`.

To go back to the version before by hand:

```bash
sudo bash deploy/install.sh --rollback
```

## Log in again

You must log in again in these cases:

- The server was off for more than 2 weeks. The refresh key expired.
- You deleted the Client ID in the portal, or you turned off a subscription.
- The log shows `Could not refresh the token`.

```bash
sudo systemctl stop mini-watch
sudo mini-watch login
sudo systemctl start mini-watch
```

For the login steps, see [Step 3](04-server-setup.md), part 7.

## Troubleshooting

| Problem | Possible cause | Fix |
|---|---|---|
| The log has no `Message:` lines | The car is asleep. | Send a remote light signal, or open and close a door. |
| No `Message:` lines, and you use the car | The stream is not set up. | In the portal, check that **Configuration status** shows **ready**. |
| `Connection refused` | The token scope is incomplete. | Check the two subscriptions. Log in again. |
| Many `Reconnecting` lines | The program runs in another place with the same account. | Stop the other copy. The account allows one connection. |
| A notification comes while you drive | The stream has no `travelledDistance`. | Add that attribute in the portal. |
| No notification for a tilted sunroof | The stream has no `tiltStatus`. | Add that attribute in the portal. |
| The time in the notification is wrong | `timezone` is empty or wrong. | Write your time zone in `config.json`. Example: `Europe/Istanbul`. |
| The log shows "Notification accepted by ntfy", but the phone shows nothing | No subscription, notifications are off, or the push did not reach the phone. | Check the topic name and the phone permissions in the ntfy app. Then follow [Lost notifications](03-ntfy.md#lost-notifications). |
| SSH shows "Connection timed out" | The `--tunnel-through-iap` flag is missing. | Add the flag. The server accepts only the IAP tunnel. |
| SSH does not answer, the flag is there | The memory of the server is full. | Wait 5 minutes. Then stop and start the server: `gcloud compute instances stop` and `start`. Do not use `reset`. Do not run `tools/replay.mjs` on the server. |

## Restart the server

Use a normal shutdown:

```bash
sudo systemctl reboot
```

Do not use the **Reset** button in the console. Do not use `gcloud compute instances reset`. A hard reset can damage files that you wrote a moment before.

## Disk use

The system journal keeps the log of the last 7 days. A job deletes the older log files every night at 05:00 in the time zone of the server. The job deletes whole files. So the log can reach back 8 days. The program limits the message history to two files of 10 MB. You do not need to clean anything. To see the free space, run `sudo mini-watch doctor`.

To see the next run of the job, run this command:

```bash
sudo systemctl list-timers mini-watch-log-clean.timer
```

To change the 7 days, change `7d` and `+7` in `deploy/mini-watch-log-clean.service`. Then run `sudo bash deploy/install.sh` again.

## Delete everything

1. In the portal, press **Delete stream** and **Delete Client**.
2. Delete the Google Cloud project:
   ```bash
   gcloud projects delete PROJECT_NAME
   ```
3. Delete the ntfy subscription on your phone.
4. If you use Pushover, delete the application on pushover.net.

**Next step:** Read [How it works](01-how-it-works.md). This page is optional.
