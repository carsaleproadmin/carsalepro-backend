# CarAPI fixtures

Real responses from `https://api.carapi.dev/v1`, captured on 2026-08-12.

**These are OBSERVED, not invented.** Every file in this directory is the exact
body the live API returned, saved unedited. That matters: the CarsXE fixtures
next door were hand-written from documentation because that account has one
lifetime lookup, and the difference in trust between the two sets is real. Write
the CarAPI mapper against these and it is written against the truth.

| File | Request | What it shows |
|---|---|---|
| `vin-decode.eu-bmw-x6.json` | `/vin-decode/WBAKU210X00R62021` | The full answer: 10 specification fields and **51 features** in 4 categories |
| `vin-decode.invalid.json` | `/vin-decode/WVWZZZ1KZAW123456` | `400`. **May mean "not in our database", not "malformed"** — and it still costs a credit |
| `mileage-history.eu-bmw-x6.json` | `/mileage-history/…` | 8 readings, 2019-12 to 2026-06, newest first |
| `stolen-check.eu-bmw-x6.json` | `/stolen-check/…` | `stolen` plus a per-country map |
| `inspection.cz.eu-bmw-x6.json` | `/inspection/…?country=CZ` | Validity dates only |
| `valuation.de.found.json` | `vw golf 2016 DE` | A single scalar price with a currency |
| `valuation.de.not-found.json` | `bmw x6 2016 DE` | The miss. Coverage is per model, not only per country |
| `time-to-sell.de.json` | `bmw x6 DE` | Median days plus the quartiles |

## What these fixtures are evidence FOR, and what they are not

The decode names Germany twice, and **neither one means the car is German**:
`manufacturer.country` is the BUILD country from the world manufacturer
identifier — BMW AG — and `manufacturer.region` is the same fact one level up.
There is no field anywhere in this API for the country a vehicle is registered
in. Do not render either as "registered in Germany".

The mileage ladder falls on a biennial-May cadence, which is the Czech and Slovak
technical-inspection cycle. So this vehicle is almost certainly CZ or SK
registered, and these 8 readings are **not** evidence that a German car returns
mileage. That question is open and one real German VIN settles it.

## Three properties the mapper has to respect

1. **There is no unit field on a mileage reading, and the values are kilometres.**
   The CarsXE mapper's `odometerUnit()` reads a blank unit as MILES, so putting
   these numbers through it turns 239 556 km into 385 527 km. The CarAPI mapper
   hard-codes kilometres and must never borrow that helper.
2. **`createdAt` is when the record was written, not when the odometer was read.**
   Some entries carry a real clock, others are midnight CEST. Do not present it
   to a buyer as the reading date.
3. **`stolen: false` covers five countries and no others.** The country map is
   the finding; the boolean alone would read as a clean bill of health for a
   vehicle whose own register was never searched.

## Refreshing

The key is on the free tier — 100 credits a month, and **every call costs one,
including a 400, a 404 and a 503**. `/v1/account` is the only free endpoint and
reports the remaining balance. There is no way to learn anything about a VIN
without spending.
