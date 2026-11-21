# #oppgaver – serverlös att-göra-lista med Slack-påminnelser

En enkel, **helt serverlös** och **gratis** att-göra-lista för teamet. Chefen
delar ut uppgifter till medarbetare, och systemet skickar automatiskt en
påminnelse i Slack **ett par timmar innan** varje uppgifts frist.

Allt körs i **GitHub Actions** – det finns ingen server att drifta. Du behöver
bara göra **en** liten engångsinställning (skapa en Slack Incoming Webhook och
klistra in den som en GitHub-secret).

---

## Vad systemet gör

- Uppgifterna ligger i filen [`tasks.json`](./tasks.json) i repots rot.
- Var 15:e minut kör ett GitHub Actions-jobb och kollar om någon uppgift
  närmar sig sin frist.
- När det är **~2 timmar kvar** (eller det antal timmar du valt) skickas en
  påminnelse till din Slack-kanal, med en @-pling till den ansvariga.
- Varje påminnelse skickas **exakt en gång** – systemet bockar av uppgiften
  (`reminded: true`) efteråt.
- Alla tider räknas korrekt mot **Europe/Stockholm**, inklusive sommar-/vintertid.

---

## Engångsinställning (måste göras en gång)

### 1. Skapa kanalen och en Slack Incoming Webhook

1. Skapa (eller välj) en Slack-kanal, t.ex. `#oppgaver`.
2. Gå till **https://api.slack.com/apps** och klicka **Create New App** →
   **From scratch**. Ge appen ett namn (t.ex. "Oppgaver") och välj din
   Slack-arbetsyta.
3. I menyn till vänster, välj **Incoming Webhooks** och slå på
   **Activate Incoming Webhooks**.
4. Klicka **Add New Webhook to Workspace** längst ner, välj kanalen
   `#oppgaver` och godkänn.
5. Kopiera webhook-URL:en. Den ser ut ungefär som
   `https://hooks.slack.com/services/T000/B000/XXXXXXXX`.

### 2. Klistra in webhooken som en GitHub-secret

1. Gå till ditt repo på GitHub → **Settings** → **Secrets and variables** →
   **Actions**.
2. Klicka **New repository secret**.
3. **Name:** `SLACK_WEBHOOK_URL`
4. **Secret:** klistra in webhook-URL:en från steg 1.
5. Spara.

> **Viktigt:** webhook-URL:en är hemlig. Den ska **bara** ligga i GitHub-secrets
> – aldrig i koden eller i `tasks.json`.

### 3. (Valfritt) Hitta ett Slack member ID för riktiga @-plingar

Om du vill att påminnelsen ska pinga personen på riktigt (`@Anna`) i stället för
bara skriva namnet:

1. I Slack, klicka på personens profil → **…** (mer) → **Copy member ID**.
2. ID:t ser ut som `U0123ABCD`.
3. Lägg det i fältet `assignee_slack_id` för uppgiften (eller i "Slack-ID" i
   formuläret). Lämnar du det tomt skrivs bara namnet ut.

---

## Så lägger du till en uppgift

### Enklast (från mobilen): via ett Issue

1. Gå till fliken **Issues** i repot → **New issue** → välj mallen **Oppgave**.
2. Fyll i:
   - **Titel** – vad som ska göras
   - **Ansvarig (namn)** – visningsnamn
   - **Slack-ID (valfritt)** – för en riktig @-pling
   - **Frist** – `YYYY-MM-DD HH:MM` (lokal tid, Europe/Stockholm), t.ex.
     `2026-11-25 15:00`
   - **Timmar innan** – hur långt i förväg påminnelsen ska skickas (standard 2)
3. Spara. En bot lägger automatiskt till uppgiften i `tasks.json` och
   kommenterar på ärendet för att bekräfta. Sommar-/vintertid räknas ut åt dig.

### Direkt i filen

Du kan också redigera [`tasks.json`](./tasks.json) direkt. En uppgift ser ut så här:

```json
{
  "id": "unik-slug",
  "title": "Lever rapport",
  "assignee": "Anna",
  "assignee_slack_id": "U0123ABCD",
  "deadline": "2026-11-25T15:00:00+01:00",
  "remind_hours_before": 2,
  "status": "open",
  "reminded": false
}
```

- `deadline` ska vara i **ISO 8601 med tidszon-offset** (`+01:00` vinter,
  `+02:00` sommar).
- `remind_hours_before` är valfritt (standard 2).
- Sätt `reminded: false` så skickas påminnelsen.

---

## Så markerar du en uppgift som klar

**Stäng (Close) ärendet** på GitHub – då sätts uppgiftens status till `done`
automatiskt och inga fler påminnelser skickas.

Redigerar du filen manuellt: sätt `"status": "done"`.

---

## Så fungerar påminnelserna

- Jobbet [`.github/workflows/reminders.yml`](./.github/workflows/reminders.yml)
  körs **var 15:e minut** (och kan köras manuellt via **Run workflow**).
- En påminnelse skickas när: `status` är `open`, `reminded` är `false`, och
  klockan är **mellan (frist − timmar innan) och fristen**.
- Efter en lyckad påminnelse sätts `reminded: true` och ändringen committas
  tillbaka till repot, så samma påminnelse inte skickas två gånger.

---

## (Valfritt) Styr uppgifterna från en visuell Slack-lista

Vill du hellre sköta uppgifterna på en **Slack-lista** (det visuella brädet som
finns på betalda Slack-planer) i stället för i filen `tasks.json`? Då kan du det
– påminnelserna fungerar precis likadant, men hämtas automatiskt från brädet.

> Det här är **helt frivilligt**. Gör du ingenting fortsätter allt som förut med
> `tasks.json`. Funktionen slås bara på om du lägger till de två sakerna nedan.

**1. Ge Slack-appen läsrättighet till listor**

1. Gå till **https://api.slack.com/apps** och öppna din app (samma som du skapade
   för webhooken, t.ex. "Oppgaver").
2. Välj **OAuth & Permissions** i menyn.
3. Under **Scopes → Bot Token Scopes**, klicka **Add an OAuth Scope** och lägg
   till **`lists:read`**.
4. Klicka **Install to Workspace** (eller **Reinstall**) högst upp och godkänn.
5. Kopiera **Bot User OAuth Token** – den börjar med `xoxb-`.

**2. Lägg till token som en GitHub-secret**

Repo → **Settings → Secrets and variables → Actions → New repository secret**:
- **Name:** `SLACK_BOT_TOKEN`
- **Secret:** klistra in `xoxb-…`-token.

**3. Skapa listan "Oppgaver"**

1. I Slack: klicka **+** (Nytt) → **Lista**, eller öppna en kanal och lägg till
   en **Lista**. Välj gärna mallen **Projektspårare** (Project tracker).
2. Se till att listan har kolumner för **Oppgave/uppgift**, **Ansvarlig**
   (persontyp), **Frist** (datumtyp) och **Status**. Namnen får vara på norska,
   svenska eller engelska – systemet känner igen dem automatiskt.

**4. Hitta listans ID**

1. Öppna listan i Slack → klicka **Dela** (eller "…"-menyn) → **Kopiera länk**.
2. Länken ser ut som `https://app.slack.com/lists/T123ABC/F0123LIST…`.
   Delen som börjar på **`F`** (t.ex. `F0123LIST`) är **listans ID**.
3. Lägg till det i GitHub under **Settings → Secrets and variables → Actions**,
   antingen som en secret eller en **variable** med namnet **`SLACK_LIST_ID`**.

**Klart!** När både `SLACK_BOT_TOKEN` och `SLACK_LIST_ID` finns läser det
schemalagda jobbet uppgifterna direkt från brädet var 15:e minut och skickar
påminnelser på samma sätt som förut (fortfarande via webhooken till `#oppgaver`).
Markerar du en uppgift som klar på brädet skickas ingen påminnelse.

- En uppgift utan ifylld **Frist** hoppas över (det finns inget att påminna om).
- Har en frist bara ett datum (ingen klockan) används **17:00** som standardtid.
  Ändra med variabeln `SLACK_LIST_DUE_DEFAULT_TIME` (t.ex. `09:00`).
- Dubbletter undviks via en liten statusfil `.reminder-state.json` som jobbet
  sparar tillbaka – varje påminnelse skickas bara en gång.

---

## Utveckling

```bash
# Kör testerna (Node 20+ krävs)
npm test

# Testa påminnelse-logiken utan att skicka något till Slack
npm run remind:dry
```

Koden har inga npm-beroenden – den använder bara inbyggda Node-moduler och
`fetch`.

<!-- Touch to force GitHub Actions workflow re-registration. -->
<!-- Re-registration touch: 2026-11-21 -->
