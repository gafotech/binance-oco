import { binanceOco } from "./src/binance-oco";

require("dotenv").config();
require("debug").enable("binance-oco");
const debug = require("debug")("binance-oco");

const exitHooks = async (cancel: Function): Promise<void> => {
  // safety mechanism - cancel order if process is interrupted.
  process.once(
    "SIGINT",
    async (code): Promise<void> => {
      debug(`handled script interrupt - code ${code}.`);
      await cancel();
    }
  );

  process.once(
    "SIGTERM",
    async (code): Promise<void> => {
      debug(`handled script interrupt - code ${code}.`);
      await cancel();
    }
  );
};

export const placeOCOOrder = async (
  pair: string,
  amount: string,
  buyPrice: string,
  buyLimitPrice: string,
  stopPrice: string,
  stopLimitPrice: string,
  targetPrice: string,
  cancelPrice: string,
  scaleOutAmount: string,
  nonBnbFees: boolean
): Promise<void> => {
  return await binanceOco(
    {
      pair: pair.toUpperCase(),
      amount,
      buyPrice,
      buyLimitPrice,
      stopPrice,
      stopLimitPrice,
      targetPrice,
      cancelPrice,
      scaleOutAmount,
      nonBnbFees
    },
    exitHooks
  );
};
