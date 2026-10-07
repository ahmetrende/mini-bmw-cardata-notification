# Step 3 of 5: Create a free server and start the program

[Türkçe](../tr/04-sunucu-kurulumu.md) · [README](../../README.md)

**Time: 30 minutes.**

The program must run 24 hours a day. This guide uses the free Google Cloud server (e2-micro). Another Ubuntu server also works. For another server, go to part 6.

Before you start, check that you have:

- [ ] The Client ID from [Step 1](02-cardata-portal.md)
- [ ] The ntfy topic name from [Step 2](03-ntfy.md)
- [ ] A Google account and a payment card

## Free limits

Check the current limits on the [Google Cloud free tier page](https://cloud.google.com/free/docs/free-cloud-features#compute) before you sign up.

| Resource | Free limit | This guide uses |
|---|---|---|
| Server | 1 e2-micro, only in `us-west1`, `us-central1` or `us-east1` | 1 server in `us-central1` |
| Disk | 30 GB standard disk | 30 GB |
| Outgoing data | 1 GB each month | Very little |
| External IP address | Free on the free server | 1 address |

You pay if you leave these limits. Examples: another region, an SSD disk, a second server.

## 1. Create a Google Cloud account

1. Go to https://cloud.google.com and sign up with your Google account.
2. Create a billing account and enter your card.

Google uses the card to check your identity. You pay nothing inside the free limits.

## 2. Open a terminal with gcloud

Choose one option.

**Option A: Cloud Shell. No install.** Open https://console.cloud.google.com and press the **Activate Cloud Shell** icon (`>_`) at the top right. The commands in this guide run in Cloud Shell as written. The author did not test Cloud Shell for this guide.

**Option B: install gcloud on your computer.** The author tested this option on macOS.

macOS with Homebrew:

```bash
brew install --cask google-cloud-sdk
gcloud auth login
```

The commands in this guide use bash syntax. They fail in Windows PowerShell. On Windows, use Option A (Cloud Shell) or install WSL.

Linux: follow https://cloud.google.com/sdk/docs/install, then run `gcloud auth login`. A browser opens. Select the Google account of part 1. If your browser has more than one Google account, check that you select the right one.

## 3. Create a project and link billing

```bash
PROJECT=cardata-notify-$(openssl rand -hex 3)
gcloud projects create "$PROJECT" --name=cardata-notification
gcloud billing accounts list
```

Copy the `ACCOUNT_ID` from the list. Then run:

```bash
gcloud billing projects link "$PROJECT" --billing-account=ACCOUNT_ID
gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com billingbudgets.googleapis.com iap.googleapis.com
```

## 4. Set a budget alert and create the server

A budget alert sends an e-mail when the cost of the project comes near a limit. Write the amount in the currency of your billing account. Example for a Turkish lira account:

```bash
gcloud billing budgets create --billing-account=ACCOUNT_ID \
  --display-name="cardata alert" --budget-amount=45TRY \
  --filter-projects="projects/$PROJECT" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=1.0
```

To find your currency, run: `gcloud billing accounts describe ACCOUNT_ID --format="value(currencyCode)"`

Create the server:

```bash
gcloud compute instances create cardata-server \
  --zone=us-central1-a --machine-type=e2-micro \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard
```

The output must show `STATUS: RUNNING`.

## 5. Close the server to the internet

Google opens SSH (22), RDP (3389) and ping to the whole internet by default. The program opens no port. It only connects out. Close all incoming connections. Allow SSH only through the Google IAP tunnel.

1. Create the IAP rule:

```bash
gcloud compute firewall-rules create allow-ssh-from-iap --network=default \
  --direction=INGRESS --action=ALLOW --rules=tcp:22 --source-ranges=35.235.240.0/20
```

2. Test the tunnel:

```bash
gcloud compute ssh cardata-server --zone=us-central1-a --tunnel-through-iap --command='echo IAP works'
```

3. Wait until you see `IAP works`. **Do not continue before that.** If you delete the public rules first, you lose access to the server.
4. Delete the public rules:

```bash
gcloud compute firewall-rules delete default-allow-ssh default-allow-rdp default-allow-icmp
```

From now on, use `--tunnel-through-iap` in each `ssh` command. This guide has the flag in all commands.

The server keeps its external IP address. The program needs it to connect to BMW and ntfy. No rule allows an incoming connection. Nobody can reach the address from outside. To delete the address you need Cloud NAT. Cloud NAT costs about 5 USD each month.

## 6. Install the program on the server

Connect to the server:

```bash
gcloud compute ssh cardata-server --zone=us-central1-a --tunnel-through-iap
```

The first connection creates an SSH key. You can leave the passphrase empty.

On the server, run these commands:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/ahmetrende/mini-bmw-cardata-notification.git
cd mini-bmw-cardata-notification
sudo bash deploy/install.sh
```

The script installs Node 22, creates the `miniwatch` user, installs the program in `/opt/mini-watch/releases` and installs the service. Your settings and data go to `/var/lib/mini-watch`. Only the `miniwatch` user can read that folder. The script also installs the `mini-watch` command. At the end it shows "Install done."

The time zone is optional. It changes only the times in the log:

```bash
sudo timedatectl set-timezone Europe/Istanbul
```

Edit the settings:

```bash
sudo nano /var/lib/mini-watch/config.json
```

Replace `client_id` and `ntfy_topic` with your values. The program does not start with the example topic name or with a name shorter than 16 characters. Set `language` to `en` or `tr`. Set `timezone` to your own time zone, for example `Europe/London`. The times in the notifications use this setting. Save: `Ctrl+O`, `Enter`, `Ctrl+X`.

## 7. Log in to your car account

**Check first that both switches in the portal are on** (Step 1, part 4). A login before the subscription does not work.

On the server, run:

```bash
sudo mini-watch login
```

The output looks like this:

```
USER_CODE=AbCd1234
VERIFICATION_URI=https://customer.bmwgroup.com/oneid/link
Enter the code in the browser within 300 seconds.
```

1. On your computer or phone, open `https://customer.bmwgroup.com/oneid/link?user_code=CODE`. Replace `CODE` with the `USER_CODE` value.
2. Log in with your MINI ID. If the code field is full, approve it. If it is empty, type the code.
3. Wait for the page "Login successful".
4. On the server, the line "Login done. Granted scope: ..." shows. The scope must have `cardata:streaming:read`.

The code is valid for 5 minutes. If it expires, run the command again.

## 8. Start the service and test

```bash
sudo systemctl enable --now mini-watch
sudo journalctl -u mini-watch -f
```

The log must show these lines:

```
History loaded: 0 messages. Last odometer increase: none.
Connected to the stream.
Subscribed: qos0
```

Press `Ctrl+C` to stop the log view. The service keeps running.

Check the setup. The output must have no `FAIL` line:

```bash
sudo mini-watch doctor
```

Send a test notification to your phone:

```bash
sudo mini-watch ntfy-test
```

The notification "MINI test: Notifications work." must arrive.

## 9. Test with the car

The car sends data only when something changes. To start the first message, do one of these:

- Send a remote light signal from the MINI app.
- Open and close a door.

After 1 or 2 minutes, the log shows lines `Message: vehicle.cabin...`.

Real test: open a window halfway. Drive a short way. Park and leave the car. A notification "MINI left open: ..." must arrive in about 10 minutes.

## Done

You can close your computer. The service starts again by itself after a server restart.

**Do not run the program with the same MINI account in another place.** BMW allows one stream connection for each account.

**Next step:** Read [Step 4, run and update the program](05-operations.md).
