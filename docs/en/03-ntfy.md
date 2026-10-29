# Step 2 of 5: Install the ntfy app on your phone

[Türkçe](../tr/03-ntfy.md) · [README](../../README.md)

**Time: 5 minutes.**

[ntfy](https://ntfy.sh) is a free, open-source notification service. It needs no account and no phone number.

## 1. Choose a topic name

The topic name works like a password. Anyone who knows the name can read your notifications. Use a long random name.

Make a random name on your computer:

```bash
echo "mini-$(openssl rand -hex 9)"
```

Example output: `mini-3f9a1c7e2b5d8e0a4c`

This command does not work in Windows PowerShell. On Windows, type a name yourself: `mini-` and then 18 random letters and digits.

Copy the name and keep it. You need it in Step 3.

## 2. Install the app and subscribe

1. Install **ntfy** from the App Store (iPhone) or from Google Play or F-Droid (Android).
2. Open the app. If it asks for notification permission, allow it.
3. Press **+**.
4. Type your topic name.
5. Keep the default server `ntfy.sh`.
6. Press **Subscribe**.

## 3. Test

Send a test notification from your computer. Replace `TOPIC` with your topic name:

```bash
curl -d "Test notification" https://ntfy.sh/TOPIC
```

A notification must arrive on your phone. If it does not arrive, check that notifications are on for ntfy in the phone settings.

## More than one phone

More than one phone can get the notifications, for example the phone of a family member. The program does not change. Each phone subscribes to the same topic.

1. Give the topic name to the other person. Use a private way, for example a message app. Do not post it in a public place.
2. The other person installs the **ntfy** app and subscribes to the same topic (see part 2 above). The server is the same as on your phone (`ntfy.sh` by default).
3. Run this test on the server:

```bash
sudo mini-watch ntfy-test
```

4. Check that every phone shows the test notification.

Notes:

- Each phone gets the same notification. You cannot set a language, a wait time or a filter for one phone. The settings in `config.json` apply to all phones.
- Each phone has its own notification settings. One phone can miss a notification while the other phone gets it.
- The program does not know which phone got a notification. ntfy gives no delivery confirmation.
- Everyone who knows the topic name can read the notifications. Everyone who knows it can also send a false notification to the topic.
- To remove a person, make a new topic name (part 1). Then change `ntfy_topic` in `config.json`, run `sudo systemctl restart mini-watch` and subscribe the phones that stay to the new name.

## New phone

A new phone needs no change on the server. The notifications go to the topic, not to one phone.

1. Find your topic name. Run this command on the server:

```bash
sudo grep ntfy_topic /var/lib/mini-watch/config.json
```

2. Install the **ntfy** app on the new phone and subscribe to the same topic (see part 2 above). The subscriptions can be missing after a phone change. Subscribe again.
3. Run `sudo mini-watch ntfy-test` on the server. The new phone must show the test notification.
4. Delete the subscription in the ntfy app of the old phone. If you lose or give away the old phone, make a new topic name instead (see the last note in "More than one phone").

## Lost notifications

ntfy.sh gives no delivery guarantee. The program knows only that ntfy.sh accepted a message. It does not know if a phone showed it.

- **What was seen.** In the author's setup, 4 notifications did not appear on the author's phone in 19 days. The author checked the program log and the ntfy cache at the time. Each message was in both. On one of these days, the second phone of the family missed the same message. This is the author's report of one setup. It is not a general loss rate.
- **A possible cause, not proven.** On an iPhone, ntfy.sh sends the push through Google Firebase and Apple. If Firebase refuses a message because of a limit, ntfy.sh blocks the Firebase pushes of that sender for 10 minutes. Source: the ntfy configuration guide. Nothing shows that this happened in the author's setup.
- **What you can check.** After a missing notification, do these steps:
  1. Look at the lock screen and the notification center first. Do not open the ntfy app before this step. When the app opens, it loads only the messages after its newest message. An older missing message does not show.
  2. Find the message id in the log. The log shows it as `ntfy id`: `sudo journalctl -u mini-watch --no-pager | grep -E "Notification (sent|accepted)"`.
  3. Run `sudo mini-watch ntfy-check <id>` on the server.
  4. Read the result. "found": ntfy has the message, so the loss is after ntfy. "missing": the cache time ended (12 hours by default), or ntfy never kept the message. "unknown": the check gives no conclusion. An ntfy server that ignores the message id of the check can send more than 64 KB, and then the result is "unknown".

ntfy gives no delivery confirmation. If a lost notification is not acceptable, a service with a delivery confirmation is an option, for example Pushover with emergency priority and a receipt. This program does not support it.

## Phone notes

**iPhone.** The author tested the program with an iPhone. Allow notifications when the app asks.

**Android.** The author did **not** test Android. The ntfy documentation gives this advice:

- A phone in doze mode can delay messages. The delay can be many minutes.
- To reduce the delay, turn on instant delivery in the ntfy settings. The option has the name "Subscription Service".
- The F-Droid build uses instant delivery for all subscriptions by default.

Menu names can change between app versions. If a notification is late on Android, check these settings first.

**Icon.** On an iPhone, the notification shows the icon of the ntfy app. This icon cannot change. The ntfy option for an own icon works only on Android. You can change the emoji at the start of the title with the setting `ntfy_tags` (see [Step 4](05-operations.md)).

## Security

- Notifications are not end-to-end encrypted. The ntfy.sh server can read the text.
- The text only names the open parts and the time, for example "Front right window since 13:50". It has no location, plate number or VIN.
- For more privacy, run your own ntfy server. Then set `ntfy_server` in `config.json`.

**Next step:** Go to [Step 3, the server setup](04-server-setup.md).
