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
- The text only names the open parts and the time, for example "Open: front right window since 13:50". It has no location, plate number or VIN.
- For more privacy, run your own ntfy server. Then set `ntfy_server` in `config.json`.

**Next step:** Go to [Step 3, the server setup](04-server-setup.md).
