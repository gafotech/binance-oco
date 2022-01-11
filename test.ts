import { placeOCOOrder } from "./index";

/**
 * Place a buy order for 1 BNB @ 0.002 BTC. Once filled, place an OCO sell for 1 BNB with:
 *
 * stop price @ 0.001 BTC
 * limit price @ 0.003 BTC
 * binance-oco -p BNBBTC -a 1 -b 0.002 -s 0.001 -t 0.003
 *
 */

placeOCOOrder(
  {
    pair: "BNBBTC",
    amount: "1",
    buyPrice: "0.002",
    buyLimitPrice: undefined,
    stopPrice: "0.001",
    stopLimitPrice: undefined,
    targetPrice: "0.003",
    cancelPrice: undefined,
    scaleOutAmount: undefined,
    nonBnbFees: false
  },
  {
    apiKey: process.env.API_KEY || "",
    apiSecret: process.env.API_SECRET || ""
  }
)
  .then(console.log)
  .catch(console.error);
