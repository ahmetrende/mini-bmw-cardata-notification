# 2. adım / 5: Telefona ntfy uygulamasını kur

[English](../en/03-ntfy.md) · [README](../../README.tr.md)

**Süre: 5 dakika.**

[ntfy](https://ntfy.sh) ücretsiz ve açık kaynaklı bir bildirim servisi. Hesap veya telefon numarası istemiyor.

## 1. Bir konu adı seç

Konu adı parola gibi davranır. Adı bilen herkes bildirimlerini okuyabilir. Bu yüzden uzun ve rastgele bir ad seç.

Bilgisayarında rastgele bir ad üret:

```bash
echo "mini-$(openssl rand -hex 9)"
```

Örnek çıktı: `mini-3f9a1c7e2b5d8e0a4c`

Bu komut Windows PowerShell'de çalışmaz. Windows'ta adı kendin yaz: `mini-` ve ardından 18 rastgele harf ve rakam.

Adı kopyala ve sakla. 3. adımda lazım olacak.

## 2. Uygulamayı kur ve abone ol

1. **ntfy** uygulamasını kur. iPhone için App Store, Android için Google Play veya F-Droid.
2. Uygulamayı aç. Bildirim izni isterse izin ver.
3. **+** düğmesine bas.
4. Konu adını yaz.
5. Sunucu ayarına dokunma. Varsayılan `ntfy.sh` kalsın.
6. **Subscribe** düğmesine bas.

## 3. Dene

Bilgisayarından bir deneme bildirimi yolla. `TOPIC` yerine kendi konu adını yaz:

```bash
curl -d "Deneme bildirimi" https://ntfy.sh/TOPIC
```

Telefonuna bildirim düşmeli. Düşmezse telefon ayarlarında ntfy için bildirimlerin açık olduğunu kontrol et.

## Birden fazla telefon

Bildirimler birden fazla telefona gelebilir. Örneğin bir aile üyesinin telefonuna. Program değişmez. Her telefon aynı konuya abone olur.

1. Konu adını diğer kişiye ver. Özel bir yol kullan, örneğin bir mesaj uygulaması. Adı herkese açık bir yerde paylaşma.
2. Diğer kişi **ntfy** uygulamasını kurar ve aynı konuya abone olur (yukarıdaki 2. bölüme bak). Sunucu, senin telefonundakiyle aynı olmalı (varsayılan `ntfy.sh`).
3. Sunucuda bu denemeyi çalıştır:

```bash
sudo mini-watch ntfy-test
```

4. Her telefonda deneme bildiriminin göründüğünü kontrol et.

Notlar:

- Her telefon aynı bildirimi alır. Tek bir telefon için dil, bekleme süresi veya filtre ayarlayamazsın. `config.json` ayarları tüm telefonlar için geçerlidir.
- Her telefonun kendi bildirim ayarları vardır. Bir telefon bir bildirimi kaçırırken diğeri alabilir.
- Program, bildirimi hangi telefonun aldığını bilmez. ntfy teslim onayı vermez.
- Konu adını bilen herkes bildirimleri okuyabilir. Adı bilen herkes konuya sahte bildirim de yollayabilir.
- Bir kişiyi çıkarmak için yeni bir konu adı üret (1. bölüm). Sonra `config.json` içindeki `ntfy_topic` alanını değiştir, `sudo systemctl restart mini-watch` komutunu çalıştır ve kalan telefonları yeni adla yeniden abone et.

## Yeni telefon

Yeni bir telefon için sunucuda bir şey değiştirmen gerekmez. Bildirimler tek bir telefona değil, konuya gider.

1. Konu adını bul. Sunucuda bu komutu çalıştır:

```bash
sudo grep ntfy_topic /var/lib/mini-watch/config.json
```

2. Yeni telefona **ntfy** uygulamasını kur ve aynı konuya abone ol (yukarıdaki 2. bölüme bak). Telefon değişince abonelikler eksik olabilir. Yeniden abone ol.
3. Sunucuda `sudo mini-watch ntfy-test` komutunu çalıştır. Yeni telefonda deneme bildirimi görünmeli.
4. Eski telefondaki ntfy uygulamasında aboneliği sil. Eski telefonu kaybedersen ya da başkasına verirsen bunun yerine yeni bir konu adı üret ("Birden fazla telefon" bölümünün son notuna bak).

## Telefon notları

**iPhone.** Program iPhone ile test edildi. Uygulama izin isteyince bildirimlere izin ver.

**Android.** Android'de **denenmedi.** ntfy belgeleri şunları söylüyor:

- Uyku modundaki (doze) bir telefon mesajları geciktirebilir. Gecikme dakikalarca sürebilir.
- Gecikmeyi azaltmak için ntfy ayarlarında anında teslimi aç. Seçeneğin adı "Subscription Service".
- F-Droid sürümü, tüm aboneliklerde anında teslimi varsayılan olarak kullanır.

Menü adları uygulama sürümüne göre değişebilir. Android'de bildirim geç geliyorsa önce bu ayarlara bak.

**Simge.** iPhone'da bildirim, ntfy uygulamasının simgesini gösterir. Bu simge değişmez. ntfy'nin kendi simge seçeneği yalnızca Android'de çalışır. Başlığın başındaki emojiyi `ntfy_tags` ayarıyla değiştirebilirsin ([4. adıma](05-isletim.md) bak).

## Güvenlik

- Bildirimler uçtan uca şifreli değil. ntfy.sh sunucusu metni okuyabilir.
- Metin yalnızca açık parçaları ve saatlerini söyler. Örnek: "Açık: sağ ön cam 13:50'den beri". Konum, plaka ve VIN yoktur.
- Daha fazla gizlilik istersen kendi ntfy sunucunu kur. Sonra `config.json` dosyasında `ntfy_server` alanını ayarla.

**Sıradaki adım:** [3. adım, sunucu kurulumu](04-sunucu-kurulumu.md) sayfasına geç.
