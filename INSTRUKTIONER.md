# Uppgiftshanteraren – publiceringsinstruktioner

## Filerna

| Fil | Innehåll |
|---|---|
| `index.html` | Appens struktur: inloggning, vyer, dialoger |
| `styles.css` | Utseende (orange/beige-tema, mobilanpassning) |
| `app.js` | All logik: inloggning, data, vyer, import/export |
| `config.js` | Adress och nyckel till Supabase – **anon-nyckeln måste fyllas i** |

## Steg 1 – Fyll i anon-nyckeln (görs nu)

1. Gå till ditt Supabase-projekt → **Project Settings** (kugghjulet längst ner i vänstermenyn) → **API Keys**.
2. Kopiera nyckeln märkt **anon / public** (en lång teckensträng).
3. Skicka den till Claude, som ger dig en färdig `config.js` – eller öppna `config.js` själv och ersätt `KLISTRA_IN_ANON-NYCKELN_HAR` med nyckeln (behåll citattecknen).

Nyckeln är avsedd att vara publik. Säkerheten ligger i databasens Row Level
Security: även med nyckeln kan ingen läsa någon annans data utan att vara
inloggad som den personen.

## Steg 2 – Lägg upp på GitHub (görs nu)

1. Gå till [github.com](https://github.com) (konto: Grucz) → **New repository**.
2. Namn: `uppgiftshanteraren`. Välj **Private** (koden innehåller inget hemligt,
   men det finns ingen anledning att ha den publik). Klicka **Create repository**.
3. Klicka **uploading an existing file** och dra in de fyra filerna
   (`index.html`, `styles.css`, `app.js`, `config.js`).
4. Klicka **Commit changes**.

## Steg 3 – Koppla Netlify (om fyra dagar, när krediterna är tillbaka)

1. Netlify → **Add new site** → **Import an existing project** → GitHub →
   välj `uppgiftshanteraren`.
2. Lämna **Build command** tomt och **Publish directory** som `/` (eller tomt) –
   detta är en statisk sida utan byggsteg, så den drar inga byggminuter att tala om.
3. Klicka **Deploy**. Notera adressen, t.ex. `https://uppgiftshanteraren.netlify.app`
   (byt gärna till ett eget namn under Site configuration → Change site name).

## Steg 4 – Tala om adressen för Supabase (direkt efter steg 3)

Utan detta steg fungerar inte Google-inloggningen från den publicerade sidan:

1. Supabase → **Authentication** → **URL Configuration**.
2. **Site URL:** skriv in Netlify-adressen, t.ex.
   `https://uppgiftshanteraren.netlify.app`.
3. Spara.

## Steg 5 – Första inloggningen och import

1. Öppna Netlify-adressen och klicka **Logga in med Google**.
   (Din Gmail-adress måste vara tillagd som testanvändare i Google Cloud:
   Google Auth Platform → Audience → Test users.)
2. Klicka på **⋮**-menyn uppe till höger → **Importera från Manus-export…**
   och välj `uppgiftshanteraren-export.json`. Efter någon minut ligger alla
   dina områden, projekt, uppgifter och händelser på plats.
3. Testa gärna från mobilen också – samma adress, samma inloggning.

## Bra att veta

- **Säkerhetskopia:** ⋮-menyn → *Exportera all data (JSON)* laddar ner allt.
  Gör det då och då.
- **Fler användare:** vem som helst du lägger till som testanvändare i Google
  Cloud kan logga in och får då en egen, helt separat lista. När du vill öppna
  för fler utan testlistan: Google Auth Platform → klicka *Publish app*.
