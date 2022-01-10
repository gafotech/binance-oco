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

interface OcoParams {
  pair: string;
  amount: string;
  buyPrice: string | undefined;
  buyLimitPrice: string | undefined;
  stopPrice: string | undefined;
  stopLimitPrice: string | undefined;
  targetPrice: string | undefined;
  cancelPrice: string | undefined;
  scaleOutAmount: string | undefined;
  nonBnbFees: boolean;
}

export const placeOCOOrder = async (params: OcoParams): Promise<void> => {
  const {
    pair,
    amount,
    buyPrice,
    buyLimitPrice,
    stopPrice,
    stopLimitPrice,
    targetPrice,
    cancelPrice,
    scaleOutAmount,
    nonBnbFees
  } = params;
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
