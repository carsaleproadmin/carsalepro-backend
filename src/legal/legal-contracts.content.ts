// Canonical per-order inspection brokerage contract templates (E10 — LegalSync).
//
// Each order, when it reaches ASSIGNED, gets a frozen contract rendered from the
// ACTIVE LegalTemplate row whose `key` is resolved from the order's country. These
// constants are the real legal text seeded into LegalTemplate (replacing the E10
// "Draft" stubs). The agreement is between the customer (buyer) and the independent
// inspector; CarSalePro is the platform broker/intermediary, NOT a party to the
// inspection itself.
//
// Placeholders use {{double_braces}} and are substituted by LegalContractService
// when a contract is rendered for a concrete order:
//   {{orderNumber}} {{contractDate}} {{customerName}} {{inspectorName}}
//   {{inspectorCompany}} {{vehicle}} {{vin}} {{address}} {{scheduledAt}}
//   {{totalEur}} {{platformFeeEur}} {{inspectorShareEur}}
//   {{inspectorTaxId}} {{inspectorVatId}}
//
// NOTE: These are professional, structured drafts — the placeholder values come from
// real order data, but the legal wording itself should still be reviewed by counsel
// before production go-live for each jurisdiction.

/** Marker the E10 seed stubs carried; used by the self-healing seed to detect them. */
export const DRAFT_MARKER = '_Draft — pending legal review (E10)._';

export type ContractKey = 'contract_de' | 'contract_eu' | 'contract_en';

export interface ContractTemplate {
  locale: string;
  title: string;
  bodyMd: string;
}

// --- contract_en: generic English fallback -------------------------------------

const CONTRACT_EN_BODY = `# Vehicle Inspection Brokerage Agreement

**Order:** {{orderNumber}}
**Date:** {{contractDate}}

## 1. Parties and roles

This agreement is entered into between:

- **The Customer** — {{customerName}}, who has requested an independent inspection of the vehicle described below; and
- **The Inspector** — {{inspectorName}}{{inspectorCompany}}, an independent professional engaged to carry out that inspection.

**CarSalePro** acts solely as the platform and broker that connects the Customer and the Inspector and processes payment. CarSalePro is **not** a party to the inspection itself, does not perform the inspection, and gives no warranty as to its outcome.

## 2. Independent contractor status (anti-employment)

The Inspector is an **independent contractor / self-employed professional**. Nothing in this agreement creates an employment, agency, partnership or joint-venture relationship between the Inspector and CarSalePro or between the Inspector and the Customer.

- The Inspector is **free to accept or decline** any order and is under no obligation of exclusivity.
- The Inspector uses **their own tools, equipment and methods** and determines how the inspection is performed.
- The Inspector is **solely responsible for their own taxes, social-security and insurance contributions**, and for any business registrations required by law.
- The Inspector is not entitled to employee benefits, paid leave, or any fixed working hours from CarSalePro.

## 3. Scope of the inspection service

The Inspector will carry out a visual and functional inspection of the following vehicle and produce an inspection report:

- **Vehicle:** {{vehicle}}
- **VIN:** {{vin}}
- **Inspection location:** {{address}}
- **Scheduled for:** {{scheduledAt}}

The inspection covers the items defined by the CarSalePro standard inspection checklist applicable at the time of the order.

## 4. Price, platform fee and inspector payout

- **Total price paid by the Customer:** {{totalEur}}
- **CarSalePro platform fee:** {{platformFeeEur}}
- **Inspector payout (share):** {{inspectorShareEur}}

Payment is collected by CarSalePro from the Customer. CarSalePro retains the platform fee and remits the Inspector's share to the Inspector after the order is approved or auto-approved, in accordance with the platform payout rules.

## 5. Cancellation and refunds

Cancellations and refunds are governed by the CarSalePro platform rules and the Terms of Use in force at the time of the order. Refund amounts depend on the order status at the time of cancellation (for example, a full refund before assignment and a partial refund after assignment). Disputes are handled through the platform's dispute resolution process.

## 6. Liability and disclaimer

The inspection report reflects the **professional opinion of the Inspector at a single point in time** and is based on the condition of the vehicle as observed during the inspection. It is **not** a guarantee or warranty of the vehicle's condition, roadworthiness, or future performance, and does not replace a manufacturer or statutory inspection. The Inspector's liability is limited to the extent permitted by applicable law. CarSalePro, as broker only, accepts no liability for the content or accuracy of the inspection report.

## 7. Tax reporting (DAC7)

The Customer and the Inspector acknowledge that, as a digital platform operator, CarSalePro may be required under the EU **DAC7** directive (and equivalent local rules) to **report the Inspector's identifying information, tax identification numbers and earnings to the competent tax authorities**, which may exchange that information with other jurisdictions.

- **Inspector Tax ID:** {{inspectorTaxId}}
- **Inspector VAT ID:** {{inspectorVatId}}

## 8. Data protection

Personal data is processed in accordance with the CarSalePro Privacy Policy. The parties agree that the data necessary to perform this agreement, to process payment and to comply with legal reporting obligations may be processed and shared accordingly.

## 9. Governing law and venue

This agreement and the inspection service are governed by the laws of the place where the inspection is performed, and the parties submit to the competent courts of that place, unless mandatory consumer-protection law provides otherwise.
`;

// --- contract_eu: EU cross-border English ---------------------------------------

const CONTRACT_EU_BODY = `# Vehicle Inspection Brokerage Agreement (EU)

**Order:** {{orderNumber}}
**Date:** {{contractDate}}

## 1. Parties and roles

This agreement is concluded between:

- **The Customer** — {{customerName}}, who has commissioned an independent inspection of the vehicle described below; and
- **The Inspector** — {{inspectorName}}{{inspectorCompany}}, an independent professional engaged to perform that inspection.

**CarSalePro** operates an online platform that brokers the connection between the Customer and the Inspector and processes payment across EU member states. CarSalePro acts **only as an intermediary** and is **not** a party to the inspection. CarSalePro does not perform the inspection and gives no warranty as to its result.

## 2. Independent contractor status (anti-employment)

The Inspector acts as an **independent, self-employed contractor**. This agreement does **not** create any employment, agency, partnership or subordination relationship between the Inspector and CarSalePro, or between the Inspector and the Customer.

- The Inspector is **free to accept or decline** any individual order and works without exclusivity.
- The Inspector supplies **their own tools, equipment and working methods** and decides how the inspection is carried out.
- The Inspector bears **sole responsibility for their own taxes, VAT, social-security and insurance contributions** in their member state of establishment.
- No employee rights (paid leave, fixed hours, benefits) arise from this agreement.

## 3. Scope of the inspection service

The Inspector will perform a visual and functional inspection and deliver an inspection report for:

- **Vehicle:** {{vehicle}}
- **VIN:** {{vin}}
- **Inspection location:** {{address}}
- **Scheduled for:** {{scheduledAt}}

The inspection covers the items in the CarSalePro standard inspection checklist applicable at the time of the order.

## 4. Price, platform fee and inspector payout

- **Total price paid by the Customer:** {{totalEur}}
- **CarSalePro platform fee:** {{platformFeeEur}}
- **Inspector payout (share):** {{inspectorShareEur}}

CarSalePro collects payment from the Customer, retains its platform fee and remits the Inspector's share once the order is approved or auto-approved, under the platform payout rules. Where the Inspector is VAT-registered, VAT is the Inspector's responsibility.

## 5. Cancellation and refunds

Cancellation and refund entitlements follow the CarSalePro platform rules and Terms of Use applicable at the time of the order, including any consumer withdrawal rights mandated by EU law. Refund amounts depend on the order status when cancelled. Disputes are resolved through the platform's dispute process.

## 6. Liability and disclaimer

The inspection report represents the **Inspector's professional opinion at a single point in time**, based on the vehicle's observable condition during the inspection. It is **not** a guarantee or warranty of condition, roadworthiness, or future performance and does not replace any statutory or manufacturer inspection. Liability is limited to the maximum extent permitted by the applicable mandatory law. CarSalePro, acting as broker only, is not liable for the content or accuracy of the report.

## 7. Tax reporting (DAC7)

The parties acknowledge that, as an EU digital-platform operator, CarSalePro is subject to Council Directive (EU) 2021/514 (**DAC7**) and may be **required to collect and report the Inspector's identification details, tax identification numbers and earnings to the competent tax authority of an EU member state**, which may automatically exchange that information with other member states.

- **Inspector Tax ID:** {{inspectorTaxId}}
- **Inspector VAT ID:** {{inspectorVatId}}

## 8. Data protection

Personal data is processed in accordance with the CarSalePro Privacy Policy and the EU General Data Protection Regulation (GDPR). The parties agree that data necessary to perform this agreement, process payment and meet legal reporting obligations may be processed and shared accordingly.

## 9. Governing law and venue

This agreement and the inspection are governed by the law of the **EU member state in which the inspection is performed**, and the parties submit to the competent courts of that member state, without prejudice to mandatory consumer-protection rules of the Customer's country of residence.
`;

// --- contract_de: German, governing law Germany ---------------------------------

const CONTRACT_DE_BODY = `# Vermittlungs- und Begutachtungsvertrag

**Auftrag:** {{orderNumber}}
**Datum:** {{contractDate}}

## 1. Parteien und Rollen

Dieser Vertrag wird geschlossen zwischen:

- **dem Kunden** — {{customerName}}, der eine unabhängige Begutachtung des nachstehend beschriebenen Fahrzeugs in Auftrag gegeben hat; und
- **dem Gutachter** — {{inspectorName}}{{inspectorCompany}}, einem selbständigen Fachmann, der mit der Durchführung der Begutachtung beauftragt ist.

**CarSalePro** ist ausschließlich die Plattform und der Vermittler, der Kunde und Gutachter zusammenführt und die Zahlung abwickelt. CarSalePro ist **nicht** Partei der Begutachtung, führt die Begutachtung nicht selbst durch und übernimmt keine Gewähr für deren Ergebnis.

## 2. Selbständigkeit (kein Arbeitsverhältnis)

Der Gutachter ist ein **selbständiger Unternehmer / Freiberufler**. Durch diesen Vertrag entsteht **kein** Arbeits-, Anstellungs-, Vertretungs-, Gesellschafts- oder Weisungsverhältnis zwischen dem Gutachter und CarSalePro oder zwischen dem Gutachter und dem Kunden.

- Der Gutachter ist **frei, einzelne Aufträge anzunehmen oder abzulehnen**, und unterliegt keiner Ausschließlichkeit.
- Der Gutachter verwendet **eigene Werkzeuge, Ausrüstung und Methoden** und bestimmt selbst, wie die Begutachtung durchgeführt wird.
- Der Gutachter trägt **allein die Verantwortung für seine eigenen Steuern, Umsatzsteuer sowie Sozial- und Versicherungsbeiträge**.
- Es bestehen keine Arbeitnehmeransprüche (Urlaub, feste Arbeitszeiten, Sozialleistungen).

## 3. Umfang der Begutachtung

Der Gutachter führt eine Sicht- und Funktionsprüfung durch und erstellt einen Gutachtenbericht für:

- **Fahrzeug:** {{vehicle}}
- **FIN:** {{vin}}
- **Ort der Begutachtung:** {{address}}
- **Geplant für:** {{scheduledAt}}

Die Begutachtung umfasst die Punkte der zum Zeitpunkt des Auftrags geltenden CarSalePro-Standard-Prüfliste.

## 4. Preis, Plattformgebühr und Auszahlung an den Gutachter

- **Vom Kunden gezahlter Gesamtpreis:** {{totalEur}}
- **CarSalePro-Plattformgebühr:** {{platformFeeEur}}
- **Auszahlung an den Gutachter (Anteil):** {{inspectorShareEur}}

CarSalePro zieht die Zahlung vom Kunden ein, behält die Plattformgebühr ein und überweist den Anteil des Gutachters nach Freigabe oder automatischer Freigabe des Auftrags gemäß den Auszahlungsregeln der Plattform.

## 5. Stornierung und Rückerstattung

Stornierungen und Rückerstattungen richten sich nach den zum Zeitpunkt des Auftrags geltenden CarSalePro-Plattformregeln und den Nutzungsbedingungen. Die Höhe der Rückerstattung hängt vom Auftragsstatus zum Zeitpunkt der Stornierung ab. Streitigkeiten werden über das Streitbeilegungsverfahren der Plattform geregelt.

## 6. Haftung und Haftungsausschluss

Der Gutachtenbericht gibt die **fachliche Einschätzung des Gutachters zu einem einzigen Zeitpunkt** wieder und beruht auf dem während der Begutachtung erkennbaren Zustand des Fahrzeugs. Er ist **keine** Garantie oder Zusicherung des Zustands, der Verkehrstauglichkeit oder der künftigen Leistung des Fahrzeugs und ersetzt keine gesetzliche oder herstellerseitige Prüfung. Die Haftung des Gutachters ist im gesetzlich zulässigen Umfang beschränkt. CarSalePro haftet als reiner Vermittler nicht für Inhalt oder Richtigkeit des Berichts.

## 7. Steuerliche Meldepflicht (DAC7)

Die Parteien nehmen zur Kenntnis, dass CarSalePro als Betreiber einer digitalen Plattform nach der EU-Richtlinie **DAC7** (Plattformen-Steuertransparenzgesetz, PStTG) verpflichtet sein kann, **die Identifikationsdaten, Steuernummern und Einkünfte des Gutachters an die zuständige Finanzbehörde zu melden**, die diese Informationen mit anderen Staaten austauschen kann.

- **Steuernummer des Gutachters:** {{inspectorTaxId}}
- **USt-IdNr. des Gutachters:** {{inspectorVatId}}

## 8. Datenschutz

Personenbezogene Daten werden gemäß der CarSalePro-Datenschutzerklärung und der EU-Datenschutz-Grundverordnung (DSGVO) verarbeitet. Die Parteien stimmen zu, dass die zur Durchführung dieses Vertrags, zur Zahlungsabwicklung und zur Erfüllung gesetzlicher Meldepflichten erforderlichen Daten entsprechend verarbeitet und weitergegeben werden dürfen.

## 9. Anwendbares Recht und Gerichtsstand

Dieser Vertrag und die Begutachtung unterliegen dem **Recht der Bundesrepublik Deutschland**. Gerichtsstand ist, soweit gesetzlich zulässig, der Ort der Begutachtung; zwingende Verbraucherschutzvorschriften bleiben unberührt.
`;

/** The real markdown for the three contract keys, replacing the E10 draft stubs. */
export const CONTRACT_TEMPLATES: Record<ContractKey, ContractTemplate> = {
  contract_de: {
    locale: 'de',
    title: 'Vermittlungs- und Begutachtungsvertrag (DE)',
    bodyMd: CONTRACT_DE_BODY,
  },
  contract_eu: {
    locale: 'en',
    title: 'Inspection Brokerage Agreement (EU)',
    bodyMd: CONTRACT_EU_BODY,
  },
  contract_en: {
    locale: 'en',
    title: 'Inspection Brokerage Agreement',
    bodyMd: CONTRACT_EN_BODY,
  },
};
