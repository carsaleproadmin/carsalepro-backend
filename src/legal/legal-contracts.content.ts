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

This agreement is written in English. English is the authoritative language of this agreement. A translation into another language, if one is supplied, is for convenience only; in the event of a conflict, the English text prevails.

## 1. Parties and roles

This agreement is concluded between:

- **The Customer** — {{customerName}}, who has commissioned an independent inspection of the vehicle described below; and
- **The Inspector** — {{inspectorName}}{{inspectorCompany}}, an independent professional engaged to perform that inspection.

**CarSalePro** operates the online platform that brings the Customer and the Inspector together, processes payment and issues this document. CarSalePro acts **only as an intermediary**. CarSalePro is not a party to the inspection, does not perform the inspection, does not supervise how it is performed, and gives no warranty as to its result.

## 2. Independent contractor status

The Inspector is an **independent contractor**. Nothing in this agreement creates an employment, agency, partnership or joint-venture relationship between the Inspector and CarSalePro, or between the Inspector and the Customer.

- The Inspector is **free to accept or decline** any order and owes no exclusivity.
- The Inspector uses **their own tools, equipment and methods** and decides how the inspection is carried out.
- The Inspector is **solely responsible for their own taxes, social-security contributions and insurance**, and for any registration, licence or permit that the law of the place of inspection requires for this activity.
- The Inspector has no claim against CarSalePro to employee benefits, paid leave or fixed working hours.

## 3. Scope of the inspection

The Inspector will inspect the following vehicle and produce an inspection report:

- **Vehicle:** {{vehicle}}
- **VIN:** {{vin}}
- **Place of inspection:** {{address}}
- **Scheduled for:** {{scheduledAt}}

The inspection covers the items in the CarSalePro standard inspection checklist in force at the time of the order.

The inspection takes place where the vehicle is located and is limited to visual examination of the vehicle's condition, including paint thickness measurement, and to documenting that condition photographically. The inspection does **not** include, in particular: starting the engine or moving the vehicle in any way; examining the underbody from below or on a lift; testing the electrics and equipment; reading the fault memory; in-depth technical diagnosis at a workshop (compression or leak-down testing, endoscopy, analysis of operating fluids, disassembly of any component); or any statutory, periodic or manufacturer technical inspection.

The Customer is responsible for arranging access to the vehicle at the agreed place and time. If access is refused or the vehicle is not present, the order is treated as cancelled by the Customer under clause 5.

## 4. Price, platform fee, payout and taxes

- **Total price paid by the Customer:** {{totalEur}}
- **CarSalePro platform fee:** {{platformFeeEur}}
- **Payout to the Inspector:** {{inspectorShareEur}}

All amounts are stated in euro. Where a party's bank or card issuer converts the amount into another currency, the conversion and any charge for it are a matter between that party and its provider, not part of this agreement.

CarSalePro collects payment from the Customer, retains the platform fee and remits the Inspector's share after the order is approved or automatically approved, in accordance with the platform payout rules.

Each party bears its own taxes. Where value-added tax, goods-and-services tax, sales tax or a similar tax is due on the Inspector's service, the Inspector is responsible for charging, declaring and paying it in accordance with the law that applies to them, and for issuing any invoice that law requires. Where CarSalePro is obliged to withhold or account for a tax, it will do so and will inform the party concerned.

## 5. Cancellation and refunds

Cancellation and refunds are governed by the CarSalePro platform rules and the Terms of Use in force at the time of the order. The amount refunded depends on the status of the order when it is cancelled. Disputes are handled through the platform's dispute-resolution process before any other step is taken.

## 6. Liability and disclaimer

The report states the **professional opinion of the Inspector at a single point in time** and is based on the condition of the vehicle that was observable during the inspection. It is **not** a guarantee or warranty of the condition, roadworthiness, safety or future performance of the vehicle, it makes no statement about the remaining service life of any component, and it does not replace a statutory or manufacturer inspection.

The Inspector is liable for damage caused intentionally or by gross negligence without limitation. For slight negligence the Inspector is liable only for breach of an obligation that is essential to this agreement, and then only for damage that was foreseeable and typical for this kind of agreement. Liability for injury to life, body or health, and any other liability that applicable law does not permit to be limited, remains unaffected.

CarSalePro, as intermediary only, accepts no liability for the content or accuracy of the report.

## 7. Consumer rights

Where the Customer is a consumer, this clause applies in addition to the rest of this agreement, and nothing in this agreement limits any right that the law of the Customer's country of residence grants them and does not permit to be waived.

Where the Customer has a statutory right to withdraw from a distance contract, that right and its time limit follow the law of the Customer's country of residence. The Customer may ask for the inspection to be carried out before that period ends; in that case, and to the extent the applicable law provides, the Customer owes a proportionate amount for the service already supplied if they then withdraw.

Consumers resident in the European Union may also use the European Commission's online dispute-resolution platform. Consumers elsewhere may use any equivalent body available to them.

## 8. Tax reporting

The Customer and the Inspector acknowledge that, as an operator of a digital platform, CarSalePro may be obliged to **report the Inspector's identifying information, tax identification numbers and earnings to the competent tax authorities**, which may exchange that information with the authorities of other countries. In the European Union this obligation arises under the **DAC7** directive; comparable obligations exist in other jurisdictions, including the OECD Model Rules for Reporting by Platform Operators.

- **Inspector Tax ID:** {{inspectorTaxId}}
- **Inspector VAT ID:** {{inspectorVatId}}

## 9. Data protection

Personal data is processed in accordance with the CarSalePro Privacy Policy. The parties agree that the data needed to perform this agreement, to process payment and to meet legal reporting obligations may be processed and shared for those purposes.

Where personal data is transferred to a country outside the one in which it was collected, the transfer is made on a legal basis permitted by the applicable data-protection law, including the standard contractual clauses where those apply.

## 10. Sanctions and lawful use

Each party confirms that it is not subject to economic sanctions that would prohibit this transaction, and that it will not use the platform, the inspection or the report for an unlawful purpose.

## 11. Force majeure

Neither party is liable for a failure to perform that is caused by an event beyond its reasonable control, including natural events, war, civil unrest, industrial action, failure of a public network, or an act of a public authority. The party affected must inform the other without undue delay. If the inspection cannot be performed for such a reason, the order is cancelled and the Customer is refunded in full.

## 12. Governing law and place of jurisdiction

This agreement and the inspection are governed by the **law of the country in which the inspection is performed**, and the parties submit to the courts of that place.

This choice of law does not deprive a Customer who is a consumer of the protection afforded to them by provisions that cannot be derogated from by agreement under the law of the country in which they have their habitual residence. Where the mandatory law of that country conflicts with a term of this agreement, that law prevails and the rest of this agreement remains in force.

## 13. Final provisions

If a provision of this agreement is or becomes invalid, the remaining provisions stay in force, and the invalid provision is replaced by the valid provision that comes closest to its commercial purpose.

This agreement, together with the CarSalePro Terms of Use and Privacy Policy in force at the time of the order, is the entire agreement between the parties on its subject matter. A change to this agreement is effective only in text form.
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

The inspection takes place where the vehicle is located and is limited to visual examination of the vehicle's condition, including paint thickness measurement, and to documenting that condition photographically. The inspection does **not** include, in particular: starting the engine or moving the vehicle in any way; examining the underbody from below or on a lift; testing the electrics and equipment; reading the fault memory; in-depth technical diagnosis at a workshop (compression or leak-down testing, endoscopy, analysis of operating fluids, disassembly of any component); or roadworthiness testing and any other statutory or manufacturer inspection. Driving on public roads is not owed.

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

Die Begutachtung findet am Standort des Fahrzeugs statt und beschränkt sich auf die Sichtprüfung des Fahrzeugzustands einschließlich der Messung der Lackdicke sowie auf deren fotografische Dokumentation. **Nicht** Gegenstand der Begutachtung sind insbesondere: das Starten des Motors und jedes Bewegen des Fahrzeugs, die Prüfung des Unterbodens von unten oder auf einer Hebebühne, die Prüfung von Elektrik und Ausstattung, das Auslesen des Fehlerspeichers, die eingehende technische Diagnose in einer Werkstatt (Kompressions- und Druckverlustmessung, Endoskopie, Analyse von Betriebsflüssigkeiten, Demontage von Bauteilen) sowie HU/AU und alle sonstigen gesetzlichen oder herstellerseitigen Prüfungen.

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
