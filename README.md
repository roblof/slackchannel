# Uppgiftspåminnelser via Slack

En **serverlös att göra-lista** med automatiska påminnelser i Slack. Du lägger
till uppgifter i en enkel YAML-fil i det här repot, och en schemalagd
GitHub Action postar en påminnelse i Slack-kanalen **#oppgaver** ett par timmar
före varje deadline – och pingar rätt person.

- Ingen server, inget konto, inget att installera.
- Körs helt på GitHub Actions – **gratis** för publika repon (och inom de
  kostnadsfria minuterna för privata).
- Det enda du behöver sätta upp själv är en Slack-webhook (se avsnittet
  [Engångsuppsättning av Slack](#engångsuppsättning-av-slack)).

---

## Så lägger du till en uppgift

1. Öppna filen [`oppgaver.yaml`](./oppgaver.yaml).
2. Kopiera ett befintligt uppgiftsblock under `uppgifter:` och klistra in det
   längst ner.
3. Fyll i fälten:
   - `id` – ett unikt nummer (eller valfri unik text).
   - `uppgift` – vad som ska göras.
   - `ansvarig` – vem som ansvarar (se [Pinga rätt person](#pinga-rätt-person)).
   - `deadline` – när det ska vara klart, i formatet **`ÅÅÅÅ-MM-DD HH:MM`**
     (t.ex. `2026-12-01 15:00`).
   - `status` – `open` för en aktiv uppgift.
4. **Committa** filen. GitHub sköter resten.

### Deadline-format och tidszon

Deadlines skrivs som `ÅÅÅÅ-MM-DD HH:MM`, till exempel `2026-12-01 15:00`.
Tiden tolkas i tidszonen som står under `installningar.tidszon` i
`oppgaver.yaml` (standard: `Europe/Stockholm`). Ändra tidszonen där om ni
sitter någon annanstans.

---

## Så markerar du en uppgift klar

Sätt `status: done` på uppgiften:

```yaml
    status: done
```

Då skickas inga fler påminnelser för den. Du kan också bara ta bort hela
uppgiftsblocket. Committa ändringen.

---

## Hur påminnelser funkar

En GitHub Action (`.github/workflows/paminnelser.yml`) körs **var 15:e minut**.
Den läser `oppgaver.yaml` och postar en påminnelse till **#oppgaver** när det är
mindre än ett par timmar kvar till en uppgifts deadline.

Hur långt före deadline påminnelsen skickas styrs av
`paminnelse_timmar_innan`:

- **Globalt** under `installningar` (standard: `2` timmar).
- **Per uppgift** – lägg till `paminnelse_timmar_innan` i ett enskilt
  uppgiftsblock för att ge just den uppgiften en egen påminnelsetid.

Varje påminnelse skickas bara **en gång**. Vilka som redan skickats spåras i
filen `.paminnelse_state.json`, som Action:en uppdaterar automatiskt.

---

## Engångsuppsättning av Slack

Det här är det enda du behöver göra själv. Du skapar en **Incoming Webhook**
som Action:en använder för att posta i #oppgaver.

1. Gå till [api.slack.com/apps](https://api.slack.com/apps) → **"Create New App"**
   → **"From scratch"** → välj din workspace.
2. Aktivera **"Incoming Webhooks"** → **"Add New Webhook to Workspace"** → välj
   kanalen **#oppgaver**.
3. Kopiera webhook-URL:en (den börjar med `https://hooks.slack.com/...`).
4. I GitHub-repot: **Settings → Secrets and variables → Actions → "New
   repository secret"** → namn **`SLACK_WEBHOOK_URL`**, värde = webhook-URL:en.

> **Obs:** en Incoming Webhook postar **alltid** till den kanal du valde i
> steg 2. Se därför till att välja **#oppgaver** där.

---

## Pinga rätt person

För att påminnelsen ska pinga (notifiera) rätt person kopplar du personens
namn till deras **Slack-medlems-ID** under `installningar.medlemmar`:

```yaml
  medlemmar:
    anna: U00000000ANNA
    erik: U00000000ERIK
```

**Så hittar du ett medlems-ID i Slack:** klicka på personens namn/profil →
**"Kopiera medlems-ID"** (ett ID som börjar med `U...`).

Fältet `ansvarig` på en uppgift kan vara:

- **ett namn från `medlemmar`** (t.ex. `anna`) – pingar personen,
- **ett Slack-ID direkt** (t.ex. `U00000000ANNA`) – pingar personen,
- **vanlig text** (t.ex. `Hela teamet`) – visas som text men pingar ingen.

---

## Viktigt: schemalagda Actions körs bara från standardgrenen

GitHub kör schemalagda workflows **endast från repots standardgren**
(oftast `main`). Den här grenen måste alltså **merge:as eller bli standardgren**
innan påminnelserna börjar köras automatiskt.

Du kan dock alltid **testa direkt**: gå till fliken **"Actions"** →
**"Uppgiftspåminnelser"** → **"Run workflow"**.

---

## Testa utan Slack

Vill du bara se vad som skulle skickas, utan att posta till Slack? Kör skriptet
lokalt utan att sätta `SLACK_WEBHOOK_URL` – då **torrkör** det och skriver ut
påminnelserna i terminalen istället:

```bash
pip install pyyaml
python scripts/skicka_paminnelser.py
```

Du kan simulera en annan tidpunkt med miljövariabeln `PAMINNELSE_NU`:

```bash
PAMINNELSE_NU="2026-12-01 14:00" python scripts/skicka_paminnelser.py
```
