# daily-crypto-briefing

DONGWOO의 일일 크립토 브리핑에 들어갈 수치를 GitHub Actions가 모아 `data/latest.json`으로 올리는 저장소입니다. Claude 클라우드 예약 작업(06:10·08:35 KST)은 이 저장소를 받아 그 파일을 읽고, 촉매와 배경은 웹 검색으로 조사해 브리핑을 발행합니다. 클라우드 작업은 TradingView·Yahoo·CoinGecko·업비트·빗썸에 직접 접속하지 못하기 때문에 이렇게 나눴습니다.

## 실행 시각 (KST)

| 시각 | 슬롯 | 내용 |
|---|---|---|
| 05:07 | morning | 전체 수집과 365선 스캔 |
| 07:47 · 08:17 | followup | 365선 스캔은 아침 값을 쓰고, 후보만 live dist를 다시 잰다. 나머지는 다시 수집한다 |

GitHub 예약 실행은 늦게 시작할 수 있습니다. Actions 탭의 「Run workflow」로 바로 돌릴 수 있습니다.

## 출력

- `data/latest.json`: 가장 최근 실행 결과. `latest-morning.json`과 `latest-followup.json`은 슬롯별 마지막 결과입니다.
- `data/charts/BTC.svg`, `ETH.svg`: 180일 일봉 차트(v9 사양: SMA 50·100·150·200·365, HMA 89·144·233 십자, 로그 축).
- `data/log.csv`: 날짜·슬롯별 핵심 값 한 줄.
- `data/scan-history.json`: 365선 갓 돌파 후보 이력(20일 채점용).
- `data/ubcs.json`: 업비트 디지털 자산 분류 저장본(매월 2일 이후 전부 다시 받음).

`latest.json`의 절:

| 키 | 내용 | 출처 |
|---|---|---|
| `ledger` | BTC.D·USDT.D·USDC.D·ΣSTABLECOIN.D·OTHERS.D·OTHERS·TOTALE50.D·TOTALE100.D·TOTAL·TOTAL3ESBTC·BTC.D/OTHERS.D: 1일·7일·30일 변화, SMA50·HMA144·SMA200·SMA365·SMA1461(4년선) 이격과 경과일, WMA200 배수(1D·3D·1W), 40일 범위 | TradingView 차트 WebSocket |
| `snapshot` | 현재값과 09:00 KST 기준 당일 변동률, Perf.W·1M·3M | TradingView scanner API |
| `ma`, `premise`, `btcdAlert` | BTC·ETH·관심 종목·XMR/ZEC 비율의 이동평균, BTC 50일선 전제 조건, BTC.D 급락 감시 | TradingView |
| `top10` | 비트 제외 시총 상위 10의 SMA50·SMA365 이격 | CoinGecko 순서 + TradingView |
| `cptra` | 채굴 수익 ÷ 거래 건수, 100봉 정규화 SMA5/50/200 | TradingView COINMETRICS |
| `igv` | IGV·SMH·SPY 이동평균 | Yahoo chart API |
| `movers` | 24h 상승·하락, 7일 상승, 회전율, 순환 위치 지수 | CoinGecko 1,000위 |
| `deriv` | 펀딩·미결제약정 | Hyperliquid |
| `scan` | 365선 갓 돌파·근접·지도·추적 | 업비트·빗썸 KRW 상장 + TradingView USD 일봉(가격 ±30% 검증, 실패 시 KRW 일봉) |
| `sectors` | UBCS 대·중분류 판(365선 위 비율, 30일 변화, 중앙 dist, 7일 중앙 수익률) | 업비트 데이터랩 |
| `meta.failures` | 실패한 출처와 이유 | |

진행 중인 봉은 마감 판정에서 빼고 `live`·`liveDist`로만 적습니다. 실패한 출처는 추정으로 채우지 않습니다.

## 시험

```
npm install
LOCAL_DIR=<wma0.3-screenshot의 data/daily> OUT_DIR=/tmp/out node scripts/collect.mjs
```

`LOCAL_DIR`을 주면 TradingView 대신 그 폴더의 일봉 종가 파일을 읽고, HTTP 출처는 건너뜁니다.

## 규칙

- TradingView는 익명 토큰으로만 읽습니다. 로그인 쿠키를 넣지 않습니다.
- 예약 실행을 살려 두려는 빈 커밋(keepalive)을 넣지 않습니다.
- 투자 조언을 만들지 않습니다. 이 저장소는 수치만 모읍니다.
