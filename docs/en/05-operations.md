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
| Sent notifications | `sudo journalctl -u mini-watch --no-pager \| grep "Notification" \| tail -20` |
| Restart | `sudo systemctl restart mini-watch` |
| Stop | `sudo systemctl stop mini-watch` |
| Test notification | `sudo mini-watch ntfy-test` |
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
| `Notification sent: ...` | A notification went to your phone. |
| `The token expires soon. Refreshing it.` | The normal refresh. It happens each hour. |
| `Reconnecting in 5 seconds.` | The connection closed. The program reconnects. You see this line each hour after a token refresh. |
| `MQTT error: Keepalive timeout` | A network break. It is normal when rare. If it is frequent, check the network. |
| `Could not refresh the token ...` | You must log in again. See below. |
| `Notification failed: ...` | ntfy was not reachable. The program tries again after 30 seconds, then waits longer each time, up to 10 minutes. If the line repeats, check the topic name and the network. |
| `Subscribe error: ... Reconnecting.` | The stream refused the subscription. The program connects again. If the line repeats, make sure that **CarData Stream** is on in the portal. |
| `The history file is full. ...` | `messages.jsonl` reached 10 MB and became `messages.jsonl.1`. This is normal. |
| `A stream message was skipped: ...` | The message was too large (more than 64 KB). The program did not store it. |
| `Unknown value "..." for ...` | The car sent a value that the program does not know. The part keeps its last state. Please open an issue and add this line. |
| `Set "ntfy_topic" ...` or `"..." must be a number of minutes ...` | The program did not start. A value in `config.json` is wrong. Correct it and restart the service. |

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
| `silence_alert_hours` | 0 (off) | One notification when the car sends no data for this many hours. The car sends nothing while it sleeps, so a long parked time also gives this notification. |
| `vehicle_names` | `{}` | Names for the cars of an account with more than one car. Example: `{"VIN-OF-CAR-1": "Countryman"}` |
| `ntfy_server` | `https://ntfy.sh` | The address of your own ntfy server |

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
| The log shows "Notification sent", but the phone shows nothing | No subscription, or notifications are off. | Check the topic name and the phone permissions in the ntfy app. |
| SSH shows "Connection timed out" | The `--tunnel-through-iap` flag is missing. | Add the flag. The server accepts only the IAP tunnel. |
| SSH does not answer, the flag is there | The memory of the server is full. | Wait 5 minutes. Then stop and start the server: `gcloud compute instances stop` and `start`. Do not use `reset`. Do not run `tools/replay.mjs` on the server. |

## Restart the server

Use a normal shutdown:

```bash
sudo systemctl reboot
```

Do not use the **Reset** button in the console. Do not use `gcloud compute instances reset`. A hard reset can damage files that you wrote a moment before.

## Disk use

The system journal limits the size of the log. The program limits the message history to two files of 10 MB. You do not need to clean anything. To see the free space, run `sudo mini-watch doctor`.

## Delete everything

1. In the portal, press **Delete stream** and **Delete Client**.
2. Delete the Google Cloud project:
   ```bash
   gcloud projects delete PROJECT_NAME
   ```
3. Delete the ntfy subscription on your phone.

**Next step:** Read [How it works](01-how-it-works.md). This page is optional.
