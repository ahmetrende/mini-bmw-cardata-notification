# 3. adım / 5: Ücretsiz sunucu aç ve programı başlat

[English](../en/04-server-setup.md) · [README](../../README.tr.md)

**Süre: 30 dakika.**

Program günün 24 saati çalışmalı. Bu rehber Google Cloud'un ücretsiz sunucusunu (e2-micro) kullanıyor. Başka bir Ubuntu sunucun varsa da olur. Öyleyse doğrudan 6. bölüme geç.

Başlamadan önce şunlara sahip olduğunu kontrol et:

- [ ] [1. adımdan](02-cardata-portali.md) Client ID
- [ ] [2. adımdan](03-ntfy.md) ntfy konu adı
- [ ] Google hesabı ve ödeme kartı

## Ücretsiz sınırlar

Kayıt olmadan önce güncel sınırlara [Google Cloud ücretsiz katman sayfasından](https://cloud.google.com/free/docs/free-cloud-features#compute) bak.

| Kaynak | Ücretsiz sınır | Bu rehberin kullandığı |
|---|---|---|
| Sunucu | 1 e2-micro, yalnızca `us-west1`, `us-central1` veya `us-east1` | `us-central1` içinde 1 sunucu |
| Disk | 30 GB standart disk | 30 GB |
| Giden veri | Ayda 1 GB | Çok az |
| Harici IP adresi | Ücretsiz sunucuda ücretsiz | 1 adres |

Bu sınırları aşarsan ücret ödersin. Örnekler: başka bir bölge, SSD disk, ikinci bir sunucu.

## 1. Google Cloud hesabı aç

1. https://cloud.google.com adresine git ve Google hesabınla kaydol.
2. Bir fatura hesabı oluştur ve kartını gir.

Google kartı, kimliğini kontrol etmek için istiyor. Ücretsiz sınırlar içinde para ödemezsin.

## 2. gcloud kurulu bir terminal aç

İki seçenekten birini seç.

**Seçenek A: Cloud Shell. Kurulum gerekmez.** https://console.cloud.google.com adresini aç. Sağ üstteki **Activate Cloud Shell** simgesine (`>_`) bas. Bu rehberdeki komutlar Cloud Shell'de olduğu gibi çalışmalı. Rehberi yazan kişi Cloud Shell'i denemedi.

**Seçenek B: gcloud'u bilgisayarına kur.** Rehberi yazan kişi bu seçeneği macOS'ta denedi.

macOS'ta Homebrew ile:

```bash
brew install --cask google-cloud-sdk
gcloud auth login
```

Bu rehberdeki komutlar bash sözdizimiyle yazıldı. Windows PowerShell'de çalışmazlar. Windows kullanıyorsan Seçenek A'yı (Cloud Shell) kullan veya WSL kur.

Linux için https://cloud.google.com/sdk/docs/install adresindeki adımları izle. Sonra `gcloud auth login` komutunu çalıştır. Tarayıcı açılır. 1. bölümdeki Google hesabını seç. Tarayıcında birden fazla Google hesabı açıksa doğru hesabı seçtiğinden emin ol.

## 3. Proje oluştur ve faturayı bağla

```bash
PROJECT=cardata-notify-$(openssl rand -hex 3)
gcloud projects create "$PROJECT" --name=cardata-notification
gcloud billing accounts list
```

Listeden `ACCOUNT_ID` değerini kopyala. Sonra şunları çalıştır:

```bash
gcloud billing projects link "$PROJECT" --billing-account=ACCOUNT_ID
gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com billingbudgets.googleapis.com iap.googleapis.com
```

## 4. Bütçe uyarısı kur ve sunucuyu oluştur

Bütçe uyarısı, projenin maliyeti bir sınıra yaklaşınca sana e-posta atar. Tutarı fatura hesabının para biriminde yaz. Türk lirası hesap için örnek:

```bash
gcloud billing budgets create --billing-account=ACCOUNT_ID \
  --display-name="cardata alert" --budget-amount=45TRY \
  --filter-projects="projects/$PROJECT" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=1.0
```

Para biriminden emin değilsen şunu çalıştır: `gcloud billing accounts describe ACCOUNT_ID --format="value(currencyCode)"`

Sunucuyu oluştur:

```bash
gcloud compute instances create cardata-server \
  --zone=us-central1-a --machine-type=e2-micro \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard
```

Çıktıda `STATUS: RUNNING` yazmalı.

## 5. Sunucuyu internete kapat

Google, varsayılan olarak SSH (22), RDP (3389) ve ping'i tüm internete açar. Program hiçbir port açmaz, yalnızca dışarıya bağlanır. Bu yüzden gelen bağlantıların hepsini kapat. SSH'a yalnızca Google IAP tüneli üzerinden izin ver.

1. IAP kuralını oluştur:

```bash
gcloud compute firewall-rules create allow-ssh-from-iap --network=default \
  --direction=INGRESS --action=ALLOW --rules=tcp:22 --source-ranges=35.235.240.0/20
```

2. Tüneli dene:

```bash
gcloud compute ssh cardata-server --zone=us-central1-a --tunnel-through-iap --command='echo IAP works'
```

3. `IAP works` yazısını görene kadar bekle. **Görmeden devam etme.** Genel kuralları önce silersen sunucuya erişimini kaybedersin.
4. Genel kuralları sil:

```bash
gcloud compute firewall-rules delete default-allow-ssh default-allow-rdp default-allow-icmp
```

Bundan sonra her `ssh` komutunda `--tunnel-through-iap` bayrağını kullan. Bu rehberdeki tüm komutlarda bayrak zaten var.

Sunucu harici IP adresini tutar. Program BMW'ye ve ntfy'ye bağlanmak için bu adrese ihtiyaç duyar. Gelen bağlantıya izin veren hiçbir kural kalmadı. Yani adrese dışarıdan kimse ulaşamaz. Adresi tamamen silmek istersen Cloud NAT gerekir. Cloud NAT ayda yaklaşık 5 USD tutar.

## 6. Programı sunucuya kur

Sunucuya bağlan:

```bash
gcloud compute ssh cardata-server --zone=us-central1-a --tunnel-through-iap
```

İlk bağlantıda bir SSH anahtarı oluşur. Parola sorarsa boş bırakabilirsin.

Sunucuda şu komutları çalıştır:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/ahmetrende/mini-bmw-cardata-notification.git
cd mini-bmw-cardata-notification
sudo bash deploy/install.sh
```

Betik Node 22'yi kurar, `miniwatch` kullanıcısını oluşturur, programı `/opt/mini-watch/releases` içine kurar ve servisi kurar. Ayarların ve verilerin `/var/lib/mini-watch` klasöründe durur. Bu klasörü yalnızca `miniwatch` kullanıcısı okuyabilir. Betik ayrıca `mini-watch` komutunu kurar. Sunucunun belleği 2 GB'tan azsa ve takas alanı yoksa 1 GB'lık bir takas dosyası ekler. İş bitince "Install done." yazar.

Saat dilimini ayarlamak isteğe bağlı. Yalnızca log'daki saatleri etkiler:

```bash
sudo timedatectl set-timezone Europe/Istanbul
```

Ayarları düzenle:

```bash
sudo nano /var/lib/mini-watch/config.json
```

`client_id` ve `ntfy_topic` değerlerini kendi değerlerinle değiştir. Program örnek konu adıyla veya 16 karakterden kısa bir adla başlamaz. `language` alanını `en` veya `tr` yap. `timezone` alanına kendi saat dilimini yaz, örneğin `Europe/Istanbul`. Bildirimlerdeki saatler bu ayara göre yazılır. Kaydetmek için `Ctrl+O`, `Enter`, `Ctrl+X` tuşlarına bas.

## 7. Araç hesabınla giriş yap

**Önce portaldaki iki anahtarın da açık olduğunu kontrol et** (1. adım, 4. bölüm). Abonelikten önce yapılan giriş çalışmaz.

Sunucuda şunu çalıştır:

```bash
sudo mini-watch login
```

Çıktı şuna benzer:

```
USER_CODE=AbCd1234
VERIFICATION_URI=https://customer.bmwgroup.com/oneid/link
Enter the code in the browser within 300 seconds.
```

1. Bilgisayarında veya telefonunda `https://customer.bmwgroup.com/oneid/link?user_code=CODE` adresini aç. `CODE` yerine `USER_CODE` değerini yaz.
2. MINI ID'nle giriş yap. Kod alanı doluysa onayla. Boşsa kodu kendin yaz.
3. "Login successful" sayfasını gör.
4. Sunucuda "Login done. Granted scope: ..." satırı çıkar. Kapsamda `cardata:streaming:read` olmalı.

Kod 5 dakika geçerli. Süresi dolarsa komutu yeniden çalıştır.

## 8. Servisi başlat ve dene

```bash
sudo systemctl enable --now mini-watch
sudo journalctl -u mini-watch -f
```

Log'da şu satırlar çıkmalı:

```
History loaded: 0 messages. Last odometer increase: none.
Connected to the stream.
Subscribed: qos0
```

Log izlemeyi bitirmek için `Ctrl+C` tuşlarına bas. Servis çalışmaya devam eder.

Kurulumu kontrol et. Çıktıda `FAIL` satırı olmamalı:

```bash
sudo mini-watch doctor
```

Telefonuna bir deneme bildirimi yolla:

```bash
sudo mini-watch ntfy-test
```

"MINI deneme: Bildirim çalışıyor." bildirimi gelmeli. (`language` değeri `en` ise metin "MINI test: Notifications work." olur.)

## 9. Aracınla dene

Araç, yalnızca bir şey değişince veri yollar. İlk mesajı tetiklemek için şunlardan birini yap:

- MINI uygulamasından uzaktan ışık sinyali yolla.
- Bir kapıyı açıp kapat.

1 veya 2 dakika sonra log'da `Message: vehicle.cabin...` satırları çıkar.

Gerçek test: Bir camı yarım aç. Kısa bir yol git. Park et ve araçtan in. Yaklaşık 10 dakika içinde "MINI açık kaldı: ..." bildirimi düşmeli.

## Bitti

Bilgisayarını kapatabilirsin. Sunucu yeniden başlarsa servis kendiliğinden açılır.

**Programı aynı MINI hesabıyla başka bir yerde çalıştırma.** BMW, hesap başına tek akış bağlantısına izin veriyor.

**Sıradaki adım:** [4. adım, programı çalıştır ve güncelle](05-isletim.md) sayfasını oku.
