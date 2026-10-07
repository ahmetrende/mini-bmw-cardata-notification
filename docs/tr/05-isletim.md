# 4. adım / 5: Programı çalıştır ve güncelle

[English](../en/05-operations.md) · [README](../../README.tr.md)

Tüm komutları sunucuda çalıştır. Sunucuya bağlanmak için:

```bash
gcloud compute ssh cardata-server --zone=us-central1-a --tunnel-through-iap
```

## Sık kullanılan komutlar

| Ne yapmak istiyorsun? | Komut |
|---|---|
| Durumu görmek | `systemctl status mini-watch --no-pager` |
| Log'u canlı izlemek | `sudo tail -f /opt/mini-watch/run.log` |
| Mesaj satırları olmadan log görmek | `sudo grep -v "Message:" /opt/mini-watch/run.log \| tail -30` |
| Yollanan bildirimleri görmek | `sudo grep "Notification" /opt/mini-watch/run.log \| tail -20` |
| Yeniden başlatmak | `sudo systemctl restart mini-watch` |
| Durdurmak | `sudo systemctl stop mini-watch` |
| Deneme bildirimi yollamak | `sudo -u miniwatch /usr/local/bin/node /opt/mini-watch/mini_watch.mjs ntfy-test` |

Log'u bilgisayarından tek komutla izlemek için:

```bash
gcloud compute ssh cardata-server --zone=us-central1-a --tunnel-through-iap --command='sudo tail -f /opt/mini-watch/run.log'
```

## Log satırları ne anlama gelir?

Log satırları her zaman İngilizce yazılır. Yalnızca bildirim metni `language` ayarına göre değişir.

| Satır | Anlamı |
|---|---|
| `Connected to the stream.` ve `Subscribed: qos0` | Bağlantı sağlıklı. |
| `Message: vehicle....` | Araçtan veri geldi. |
| `Notification sent: ...` | Telefonuna bildirim yollandı. |
| `The token expires soon. Refreshing it.` | Normal yenileme. Her saat olur. |
| `Reconnecting in 5 seconds.` | Bağlantı kapandı, program yeniden bağlanıyor. Token yenilemesinden sonra bu satırı her saat görürsün. |
| `MQTT error: Keepalive timeout` | Ağ kesintisi. Arada bir olması normal. Sık oluyorsa ağı kontrol et. |
| `Could not refresh the token ...` | Yeniden giriş yapman gerekiyor. Aşağıya bak. |
| `Notification failed: ...` | ntfy'ye ulaşılamadı. Program 30 saniye sonra yeniden dener, sonra her seferinde daha uzun bekler, en çok 10 dakika. Satır tekrar ediyorsa konu adını ve ağı kontrol et. |
| `Subscribe error: ... Reconnecting.` | Akış aboneliği reddetti. Program yeniden bağlanır. Satır tekrar ediyorsa portalda **CarData Stream** anahtarının açık olduğunu kontrol et. |
| `Unknown value "..." for ...` | Araç, programın tanımadığı bir değer yolladı. Parça son bilinen durumunda kalır. Lütfen bir issue aç ve bu satırı ekle. |
| `Set "ntfy_topic" ...` veya `"..." must be a number of minutes ...` | Program başlamadı. `config.json` içindeki bir değer hatalı. Düzelt ve servisi yeniden başlat. |

## Ayarları değiştir

```bash
sudo nano /opt/mini-watch/config.json
sudo systemctl restart mini-watch
```

| Alan | Varsayılan | Anlamı |
|---|---|---|
| `language` | `en` | Bildirim metninin dili: `en` veya `tr` |
| `timezone` | sunucunun saat dilimi | Bildirimdeki saatlerin saat dilimi. Örnek: `Europe/Istanbul` |
| `alert_after_min` | 10 | Sürücü kapısı son açıldıktan sonra bildirimden önceki bekleme |
| `remind_every_min` | 60 | Parça hâlâ açıksa ilk hatırlatma süresi. Sonraki her hatırlatma iki kat bekler. |
| `remind_max_min` | 480 | İki hatırlatma arasındaki en uzun süre |
| `park_after_idle_min` | 30 | Kilometre bu kadar durursa araç park sayılır |
| `ntfy_server` | `https://ntfy.sh` | Kendi ntfy sunucunun adresi |

## Programı güncelle

1. Sunucuya bağlan.
2. Şunu çalıştır:

```bash
cd ~/mini-bmw-cardata-notification
git pull
sudo bash deploy/install.sh
```

Betik `config.json` ve `tokens.json` dosyalarına dokunmaz. Servis çalışıyorsa yeniden başlatır.

## Yeniden giriş yap

Şu durumlarda yeniden giriş yapman gerekir:

- Sunucu 2 haftadan uzun süre kapalı kaldı. Yenileme anahtarının süresi doldu.
- Portalda Client ID'yi sildin veya bir aboneliği kapattın.
- Log'da `Could not refresh the token` satırı çıkıyor.

```bash
sudo systemctl stop mini-watch
sudo -u miniwatch /usr/local/bin/node /opt/mini-watch/mini_watch.mjs login
sudo systemctl start mini-watch
```

Giriş adımları için [3. adımın](04-sunucu-kurulumu.md) 7. bölümüne bak.

## Sorun giderme

| Sorun | Olası sebep | Çözüm |
|---|---|---|
| Log'da hiç `Message:` satırı yok | Araç uykuda. | Uzaktan ışık sinyali yolla veya bir kapıyı açıp kapat. |
| `Message:` satırı yok, ama aracı kullanıyorsun | Akış kurulu değil. | Portalda **Configuration status** değerinin **ready** olduğunu kontrol et. |
| `Connection refused` | Token kapsamı eksik. | İki aboneliği kontrol et. Yeniden giriş yap. |
| Çok sayıda `Reconnecting` satırı | Program aynı hesapla başka bir yerde de çalışıyor. | Diğer kopyayı durdur. Hesap tek bağlantıya izin veriyor. |
| Yoldayken bildirim geliyor | Akışta `travelledDistance` yok. | Portalda bu özniteliği ekle. |
| Aralık cam tavan için bildirim gelmiyor | Akışta `tiltStatus` yok. | Portalda bu özniteliği ekle. |
| Bildirimdeki saat yanlış | `timezone` ayarı boş veya yanlış. | `config.json` içine kendi saat dilimini yaz. Örnek: `Europe/Istanbul`. |
| Log "Notification sent" diyor ama telefonda bir şey yok | Abonelik yok veya bildirimler kapalı. | ntfy uygulamasında konu adını ve telefon izinlerini kontrol et. |
| SSH "Connection timed out" veriyor | `--tunnel-through-iap` bayrağı eksik. | Bayrağı ekle. Sunucu yalnızca IAP tünelini kabul ediyor. |

## Sunucuyu yeniden başlat

Normal kapanışı kullan:

```bash
sudo systemctl reboot
```

Konsoldaki **Reset** düğmesini veya `gcloud compute instances reset` komutunu kullanma. Ani sıfırlama, hemen önce yazdığın dosyaları bozabilir.

## Disk kullanımı

`run.log` ve `messages.jsonl` sürekli büyür. Her biri günde birkaç MB tutar. 30 GB disk yıllarca yeter. Temizlemek istersen:

```bash
sudo systemctl stop mini-watch
sudo truncate -s 0 /opt/mini-watch/run.log
sudo -u miniwatch sh -c 'tail -n 5000 /opt/mini-watch/messages.jsonl > /tmp/m && mv /tmp/m /opt/mini-watch/messages.jsonl'
sudo systemctl start mini-watch
```

## Her şeyi sil

1. Portalda **Delete stream** ve **Delete Client** düğmelerine bas.
2. Google Cloud projesini sil:
   ```bash
   gcloud projects delete PROJECT_NAME
   ```
3. Telefondaki ntfy aboneliğini sil.

**Sıradaki adım:** [Nasıl çalışır](01-nasil-calisir.md) sayfasını oku. Bu sayfa isteğe bağlı.
