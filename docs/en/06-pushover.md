# Optional: Pushover instead of ntfy

[Türkçe](../tr/06-pushover.md) · [README](../../README.md)

This page is optional. By default, the program sends the notifications through ntfy. One setting changes the service to Pushover.

**Status.** The program part is ready and has tests. The steps on the phone (account, app and keys) are **not yet tested on a phone**. Each of these steps has this note. The facts about the Pushover service on this page come from pushover.net and its support pages. The author checked them on 2026-10-31. A fact that is still open has a note.

## When to use Pushover

[Pushover](https://pushover.net) is a paid notification service with its own phone app.

- ntfy gives no delivery confirmation. In the author's setup, some notifications did not appear on the phone. See [Lost notifications](03-ntfy.md#lost-notifications).
- On an iPhone, ntfy.sh sends the push through Google Firebase and Apple. Source: the ntfy configuration guide. Pushover sends the push to Apple directly. According to the Pushover support page "Notification storage and delivery", Pushover keeps each message on its server until the phone confirms it. If a push is lost, the app can download the message when you open it.
- If ntfy works well for you, keep ntfy. You do not need this page.

According to pushover.net, only the emergency priority gives a receipt. The program does not use that priority. As with ntfy, the program counts a notification as sent when Pushover accepts it.

## Cost

- According to pushover.net, Pushover has a free trial of 30 days. The page does not say when the 30 days start.
- According to pushover.net, the app then costs 4.99 USD one time for each platform, for example iPhone. The license covers all your own devices of that platform. One license is not for more than one person.
- According to the Pushover support page about the price, Pushover stops the delivery to your device if you buy no license within 24 hours after the trial. Each person who gets notifications needs an own license.
- The person buys the license. An AI tool must not do this step.

## The switch

| Setting | Default | Meaning |
|---|---|---|
| `notify_service` | `ntfy` | The service for all notifications: `ntfy` or `pushover`. The program uses one service at a time. |
| `pushover_token` | empty | The API token of your Pushover application. 30 letters and digits. Keep it secret. |
| `pushover_user` | empty | Your Pushover user key, or a delivery group key. 30 letters and digits. Keep it secret. |

With `ntfy`, the program ignores `pushover_token` and `pushover_user`. With `pushover`, the program needs both keys and does not use `ntfy_topic`.

**Keep `ntfy_topic` in `config.json`, also with Pushover.** `ntfy-test` needs it. A rollback to a release before Pushover (`sudo bash deploy/install.sh --rollback`) needs it too. That older release does not know `notify_service`. It sends through ntfy, and without `ntfy_topic` it does not start. With Pushover, `sudo mini-watch doctor` shows a `WARN` line when `ntfy_topic` is empty or not valid.

## 1. Make the account and the keys

**Not yet tested on a phone.** The names on the website and in the app can be different.

1. Open [pushover.net](https://pushover.net) and make an account. Only the person does this step.
2. Install the **Pushover** app on the phone. Log in with the same account. The trial probably starts when you log in to the app.
3. Allow notifications when the app asks.
4. On pushover.net, find **Your User Key**. Copy it. This is the value of `pushover_user`.
5. On pushover.net, make an application (**Create an Application/API Token**). Give it a name, for example `MINI`. Copy the **API Token**. This is the value of `pushover_token`.

Keep the two keys like passwords. Do not put them in a chat, a commit or a screenshot.

## 2. Write the keys in config.json

```bash
sudo nano /var/lib/mini-watch/config.json
```

The first line of the file has only `{`. Add the new lines directly after this line, at the start of the file. Each new line ends with a comma. Do not change the other lines.

If the file has no `notify_service` line, add these three lines. Use your own keys. The `{` line is already in the file, so do not add it again:

```json
{
  "notify_service": "ntfy",
  "pushover_token": "YOUR-PUSHOVER-API-TOKEN",
  "pushover_user": "YOUR-PUSHOVER-USER-KEY",
```

If the file already has a `notify_service` line, do not add a second one. Add only the `pushover_token` and `pushover_user` lines. Keep `notify_service` at `ntfy` for now.

Save: `Ctrl+O`, `Enter`, `Ctrl+X`.

The service reads `config.json` only when it starts. A mistake in the file stops the service at the next start, also after a server restart. So check the file now. The output must have no `FAIL` line:

```bash
sudo mini-watch doctor --offline
```

If the output says that `config.json` is not valid JSON, check the quotes and the commas. While `notify_service` is `ntfy`, the service does not use the keys. So you do not need a restart now.

## 3. Send a test notification

**Not yet tested on a phone.**

```bash
sudo mini-watch pushover-test
```

The command sends a real notification through Pushover. It also works while `notify_service` is `ntfy`. So you can test Pushover before you switch.

- Good result: the output shows `Notification accepted by Pushover` with the request id. The last line is `Result: Pushover accepted the test notification. Check the phone.` The program sends the title "🚗 MINI test" and the text "Notifications work". With `language` set to `tr`, it sends "🚗 MINI deneme bildirimi" and "Bildirim çalışıyor". How the phone shows them is not yet tested.
- Bad result: the last line is `Result: Pushover did not accept the test notification. See the line above.` The line above it gives the reason. See [Troubleshooting](#troubleshooting).
- A missing or wrong key in `config.json` stops the command before it sends. The error names the setting. It does not show the value.

## 4. Switch to Pushover

**Not yet tested on a phone.**

1. Open `config.json` (part 2). In the line with `"notify_service"`, change the value `"ntfy"` to `"pushover"`. Do not change the other characters of the line.
2. Check the file before the restart. The output must have no `FAIL` line:

```bash
sudo mini-watch doctor --offline
```

3. Restart the service:

```bash
sudo systemctl restart mini-watch
```

4. Look at the log. After the restart, it shows the line `Notification service: Pushover.`

```bash
sudo journalctl -u mini-watch -n 20 --no-pager
```

5. Check the setup. The output must have no `FAIL` line. The check asks Pushover if the keys are valid. It sends no notification. With Pushover, a problem with the ntfy server shows as `WARN`, not as `FAIL`. An empty `ntfy_topic` also shows as `WARN`.

```bash
sudo mini-watch doctor
```

If the program does not start, the log shows the wrong setting. Correct it and restart the service again.

## 5. Switch back to ntfy

1. Open `config.json`. In the line with `"notify_service"`, change the value `"pushover"` to `"ntfy"`. Do not change the other characters of the line.
2. Check the file before the restart: `sudo mini-watch doctor --offline`. The output must have no `FAIL` line.
3. Restart the service: `sudo systemctl restart mini-watch`.

The ntfy service needs `ntfy_topic`. If you deleted that setting, write it again before the restart. Without it, the program does not start. The Pushover keys can stay in `config.json`. With `ntfy`, the program does not use them.

## What stays the same

- The default service is `ntfy`. A `config.json` without `notify_service` works as before.
- The ntfy part does not change. `ntfy-test`, `ntfy-check` and the `ntfy_*` settings work as before. They always use ntfy.
- The texts, the wait times, the reminders and the retries are the same for the two services.
- With Pushover, the emoji also comes from `ntfy_tags`. The program sends no tags to Pushover. It puts the emoji at the start of the title.
- The program knows these tag names: `warning` (⚠️), `rotating_light` (🚨), `white_check_mark` (✅), `lock` (🔒), `grey_question` (❔), `blue_car` (🚙), `car` (🚗). Another tag name gives no emoji.
- The notifications "a part is open" and "a part is still open" get Pushover priority 1 (high). The other notifications get priority 0 (normal).
- The title has 250 characters or less. The text has 1024 characters or less. A longer text ends with "…".
- `ntfy-check` works only for ntfy. A Pushover message has a request id, not an ntfy id.
- The tool `tools/replay.mjs` sends nothing, also with `pushover`.

## Troubleshooting

| Log line | Meaning |
|---|---|
| `Notification accepted by Pushover: ... (request <id>, HTTP 200)` | Pushover accepted the notification. This is not a delivery confirmation. |
| `Notification not confirmed by Pushover: ...` | Pushover answered with HTTP 2xx, but the answer has no request id. The program does not count the notification as sent. It tries again later, as with ntfy. |
| `Notification failed: HTTP 400` or `HTTP 401` | Pushover refused the message. A key can be wrong. Run `sudo mini-watch doctor`. |
| `Notification failed: HTTP 429` | Pushover refused the message. A possible cause is a limit of Pushover. The program tries again later. |
| `Notification failed: HTTP 307, a redirect. ...` | Pushover answered with a redirect. The request has the token, so the program does not follow the redirect. It tries again later. |
| `Notification failed: no answer from Pushover (...)` or `Notification failed: no answer from Pushover in 15 seconds` | The server could not reach Pushover, or Pushover did not answer in time. The text in parentheses is the error code. The program tries again later. |
| `Set "pushover_token" ...` or `"pushover_user" must have 30 letters and digits ...` | The program did not start. A key in `config.json` is missing or wrong. The text does not show the value. |
| `"notify_service" must be "ntfy" or "pushover" ...` | The program did not start. Correct the value in `config.json`. |

The retries follow the same rules as with ntfy. See the line `Notification failed` in [Step 4](05-operations.md#log-lines).

## Limits

- **Not yet tested on a phone.** The tests of the program part use a fake Pushover answer only.
- **No emergency priority yet.** Pushover has an emergency priority (2). According to pushover.net, it repeats a notification until you confirm it, and it gives a receipt. The program does not use it. It is a possible later step.
- **Delivery groups.** The program accepts a delivery group key in `pushover_user`. According to pushover.net, a group key works in place of a user key. The owner of the application shares a subscription link, and each person opens the link to subscribe. A message to a group counts once for each member in the monthly limit. The support page does not say if a member needs an own Pushover account and an own license. No step with a group is tested on a phone yet.
- **Monthly limit.** According to pushover.net, a free account can send 10,000 messages in a month. The program sends a few messages each day.
- **Rollback.** A release before Pushover sends through ntfy and needs `ntfy_topic`. See [The switch](#the-switch).
- **Retries after an error answer.** After an HTTP 4xx answer from Pushover, the program tries again with the normal wait times (see [Step 4](05-operations.md#log-lines)). According to pushover.net, a 4xx answer means that the same request does not work. Many failed requests within a few minutes block the IP address of the server for a time. The wait between two tries grows from 30 seconds to 10 minutes, so the risk is low. Switch back to ntfy if the log shows repeated refusals.
- **One service at a time.** The program does not send to ntfy and Pushover together.
- **Privacy.** The notifications go through the Pushover servers. The text has no location, plate number or VIN.

**Next step:** Go back to [Step 4, run and update the program](05-operations.md).
