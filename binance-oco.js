const debug = require('debug')('binance-oco');
const Joi = require('joi');
const Binance = require('./lib/node-binance-api-async');

const schema = Joi.object().keys({
  pair: Joi.string().uppercase().required(),
  amount: Joi.number().positive().required(),
  buyPrice: Joi.number().min(0),
  buyLimitPrice: Joi.number().positive(),
  cancelPrice: Joi.number().positive(),
  stopPrice: Joi.number().positive()
    .when('buyPrice', {
      is: Joi.number().greater(0).required(),
      then: Joi.number().less(Joi.ref('buyPrice')),
    }),
  stopLimitPrice: Joi.number().positive(),
  targetPrice: Joi.number().positive()
    .when('stopPrice', {
      is: Joi.required(),
      then: Joi.number().greater(Joi.ref('stopPrice')),
    })
    .when('buyPrice', {
      is: Joi.required(),
      then: Joi.number().greater(Joi.ref('buyPrice')),
    }),
  scaleOutAmount: Joi.number().less(Joi.ref('amount')).positive(),
  nonBnbFees: Joi.boolean(),
}).or('buyPrice', 'stopPrice', 'targetPrice')
  .with('buyLimitPrice', 'buyPrice')
  .with('cancelPrice', 'buyPrice')
  .with('stopLimitPrice', 'stopPrice')
  .with('scaleOutAmount', 'targetPrice');

const binanceOco = async (options) => {
  const result = Joi.validate(options, schema);
  if (result.error !== null) {
    throw new Error(result.error);
  }

  const {
    pair,
    cancelPrice,
    nonBnbFees,
  } = options;

  let {
    amount, buyPrice, buyLimitPrice, stopPrice, stopLimitPrice, targetPrice,
    scaleOutAmount,
  } = options;

  const binance = new Binance();

  const disconnect = () => {
    const endpoints = binance.websockets.subscriptions();
    // eslint-disable-next-line guard-for-in, no-restricted-syntax
    for (const endpoint in endpoints) {
      binance.websockets.terminate(endpoint);
    }
  };

  const NON_BNB_TRADING_FEE = 0.001;

  const calculateSellAmount = (commissionAsset, sellAmount) => ((commissionAsset === 'BNB' && !nonBnbFees) ? sellAmount : (sellAmount * (1 - NON_BNB_TRADING_FEE)));

  let stopSellAmount;
  let targetSellAmount;

  const calculateStopAndTargetAmounts = (commissionAsset) => {
    stopSellAmount = calculateSellAmount(commissionAsset, stopSellAmount);
    targetSellAmount = calculateSellAmount(commissionAsset, targetSellAmount);
  };

  let isCancelling = false;

  const cancelOrderAsync = async (symbol, orderId) => {
    if (!isCancelling) {
      isCancelling = true;
      try {
        const response = await binance.cancelAsync(symbol, orderId);

        debug('Cancel response: %o', response);
        debug(`order id: ${response.orderId}`);
      } catch (err) {
        debug(`${symbol} cancel error:`, err.body);
      } finally {
        isCancelling = false;
      }
    }
  };

  const placeStopOrderAsync = async (orderAmount) => {
    try {
      const response = await binance.sellAsync(pair, orderAmount, stopLimitPrice || stopPrice, { stopPrice, type: 'STOP_LOSS_LIMIT', newOrderRespType: 'FULL' });

      debug('Sell response: %o', response);
      debug(`order id: ${response.orderId}`);

      return response.orderId;
    } catch (err) {
      throw new Error(err.body);
    }
  };

  const placeTargetOrderAsync = async (orderAmount) => {
    try {
      const response = await binance.sellAsync(pair, orderAmount, targetPrice, { type: 'LIMIT', newOrderRespType: 'FULL' });

      debug('Sell response: %o', response);
      debug(`order id: ${response.orderId}`);

      return response.orderId;
    } catch (err) {
      throw new Error(err.body);
    }
  };

  const isOrderFilled = (data) => {
    const {
      s: symbol, L: lastExecutedPrice, l: lastExecutedQuantity, z: filledQuantity, S: side,
      o: orderType, i: orderId, X: orderStatus,
    } = data;

    debug(`${symbol} ${side} ${orderType} ORDER #${orderId} (${orderStatus})`);
    debug(`..price: ${lastExecutedPrice}, quantity: ${lastExecutedQuantity}, filled quantity: ${filledQuantity}`);

    if (orderStatus === 'NEW' || orderStatus === 'PARTIALLY_FILLED') {
      return false;
    }

    if (orderStatus !== 'FILLED') {
      throw new Error(`Order ${orderStatus}. Reason: ${data.r}`);
    }

    return true;
  };

  const waitForSellOrderFill = sellOrderId => new Promise((resolve, reject) => {
    let stopOrderId = sellOrderId;
    let targetOrderId = 0;

    try {
      binance.websockets.trades(pair, async (trades) => {
        try {
          const { s: symbol, p: price } = trades;
          debug(`${symbol} trade update. price: ${price} stop: ${stopPrice} target: ${targetPrice}`);
          if (stopOrderId && !targetOrderId && price >= targetPrice && !isCancelling) {
            await cancelOrderAsync(symbol, stopOrderId);
            stopOrderId = 0;
            targetOrderId = await placeTargetOrderAsync(targetSellAmount);
          } else if (targetOrderId && !stopOrderId && price <= stopPrice && !isCancelling) {
            await cancelOrderAsync(symbol, targetOrderId);
            targetOrderId = 0;
            stopOrderId = await placeStopOrderAsync(stopSellAmount);
          }
        } catch (err) {
          reject(err);
        }
      });

      binance.websockets.userData(() => { }, (data) => {
        try {
          const { i: orderId } = data;
          if (orderId === stopOrderId || orderId === targetOrderId) {
            if (isOrderFilled(data)) {
              resolve();
            }
          }
        } catch (err) {
          reject(err);
        }
      });

      binance.orderStatusAsync(pair, sellOrderId).then((response) => {
        if (response.status === 'FILLED') {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });

  let isLimitEntry = false;
  let isStopEntry = false;

  const waitForBuyOrderFill = buyOrderId => new Promise((resolve, reject) => {
    try {
      binance.websockets.trades(pair, async (trades) => {
        try {
          const { s: symbol, p: price } = trades;
          if (!cancelPrice) {
            debug(`${symbol} trade update. price: ${price} buy: ${buyPrice}`);
          } else {
            debug(`${symbol} trade update. price: ${price} buy: ${buyPrice} cancel: ${cancelPrice}`);

            if (((isStopEntry && price <= cancelPrice)
              || (isLimitEntry && price >= cancelPrice))
              && !isCancelling) {
              await cancelOrderAsync(symbol, buyOrderId);
              reject(new Error(`Order CANCELED. Reason: cancel price ${cancelPrice} hit`));
            }
          }
        } catch (err) {
          reject(err);
        }
      });

      binance.websockets.userData(() => { }, (data) => {
        try {
          const { i: orderId } = data;
          if (orderId === buyOrderId && isOrderFilled(data)) {
            if (stopPrice || targetPrice) {
              const { N: commissionAsset } = data;
              calculateStopAndTargetAmounts(commissionAsset);
            }
            resolve();
          }
        } catch (err) {
          reject(err);
        }
      });

      binance.orderStatusAsync(pair, buyOrderId).then((response) => {
        if (response.status === 'FILLED') {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });

  await binance.optionsAsync({
    APIKEY: process.env.APIKEY,
    APISECRET: process.env.APISECRET,
    useServerTime: true,
    reconnect: true,
  });

  const symbolData = (await binance.exchangeInfoAsync()).symbols.find(ei => ei.symbol === pair);
  if (!symbolData) {
    throw new Error(`Could not pull exchange info for ${pair}`);
  }

  const { filters } = symbolData;
  const { stepSize, minQty } = filters.find(eis => eis.filterType === 'LOT_SIZE');
  const { tickSize, minPrice } = filters.find(eis => eis.filterType === 'PRICE_FILTER');
  const { minNotional } = filters.find(eis => eis.filterType === 'MIN_NOTIONAL');

  amount = binance.roundStep(amount, stepSize);

  if (amount < minQty) {
    throw new Error(`Amount ${amount} does not meet minimum order amount ${minQty}.`);
  }

  if (scaleOutAmount) {
    scaleOutAmount = binance.roundStep(scaleOutAmount, stepSize);

    if (scaleOutAmount < minQty) {
      throw new Error(`Scale out amount ${scaleOutAmount} does not meet minimum order amount ${minQty}.`);
    }

    const remainingAmount = amount - scaleOutAmount;
    if (remainingAmount < minQty) {
      throw new Error(`Stop amount after scale out (${remainingAmount}) will not meet minimum order amount ${minQty}.`);
    }
  }

  stopSellAmount = amount;
  targetSellAmount = scaleOutAmount || amount;

  if (buyPrice) {
    buyPrice = binance.roundTicks(buyPrice, tickSize);

    if (buyPrice < minPrice) {
      throw new Error(`Buy price ${buyPrice} does not meet minimum order price ${minPrice}.`);
    }

    if (buyPrice * amount < minNotional) {
      throw new Error(`Buy order does not meet minimum order value ${minNotional}.`);
    }

    if (buyLimitPrice) {
      buyLimitPrice = binance.roundTicks(buyLimitPrice, tickSize);
    } else {
      const balances = await binance.balanceAsync();
      const { quoteAsset } = symbolData;
      const { available } = balances[quoteAsset];
      const maxAvailablePrice = binance.roundTicks(available / amount, tickSize);

      const prices = await binance.avgPriceAsync(pair);
      const currentPrice = Object.values(prices)[0];
      const { multiplierUp } = filters.find(eis => eis.filterType === 'PERCENT_PRICE');
      const maxPercentPrice = binance.roundTicks(currentPrice * multiplierUp, tickSize);

      buyLimitPrice = Math.min(maxAvailablePrice, maxPercentPrice);

      const { quotePrecision } = symbolData;
      buyLimitPrice = (parseFloat(buyLimitPrice) - parseFloat(tickSize))
        .toFixed(quotePrecision);
    }
  }

  if (stopPrice) {
    stopPrice = binance.roundTicks(stopPrice, tickSize);

    if (stopPrice < minPrice) {
      throw new Error(`Stop price ${stopPrice} does not meet minimum order price ${minPrice}.`);
    }

    const minStopSellAmount = stopSellAmount - targetSellAmount
      ? Math.min(targetSellAmount, stopSellAmount - targetSellAmount)
      : stopSellAmount;
    if (stopPrice * minStopSellAmount < minNotional) {
      throw new Error(`Stop order does not meet minimum order value ${minNotional}.`);
    }

    if (stopLimitPrice) {
      stopLimitPrice = binance.roundTicks(stopLimitPrice, tickSize);

      if (stopLimitPrice < minPrice) {
        throw new Error(`Stop limit price ${stopLimitPrice} does not meet minimum order price ${minPrice}.`);
      }

      if (stopLimitPrice * minStopSellAmount < minNotional) {
        throw new Error(`Stop order does not meet minimum order value ${minNotional}.`);
      }
    } else {
      const prices = await binance.avgPriceAsync(pair);
      const currentPrice = Object.values(prices)[0];
      const { multiplierDown } = filters.find(eis => eis.filterType === 'PERCENT_PRICE');
      const minPercentPrice = binance.roundTicks(currentPrice * multiplierDown, tickSize);
      const minNotionalPrice = binance.roundTicks(minNotional / minStopSellAmount, tickSize);

      stopLimitPrice = Math.max(minPrice, minPercentPrice, minNotionalPrice);

      const { quotePrecision } = symbolData;
      stopLimitPrice = (parseFloat(stopLimitPrice) + parseFloat(tickSize))
        .toFixed(quotePrecision);
    }
  }

  if (targetPrice) {
    targetPrice = binance.roundTicks(targetPrice, tickSize);

    if (targetPrice < minPrice) {
      throw new Error(`Target price ${targetPrice} does not meet minimum order price ${minPrice}.`);
    }

    if (targetPrice * targetSellAmount < minNotional) {
      throw new Error(`Target order does not meet minimum order value ${minNotional}.`);
    }
  }

  if (buyPrice >= 0) {
    let response;
    try {
      if (buyPrice === 0) {
        response = await binance.marketBuyAsync(pair, amount, { type: 'MARKET', newOrderRespType: 'FULL' });
      } else if (buyPrice > 0) {
        const ticker = await binance.pricesAsync(pair);
        const currentPrice = ticker[pair];
        debug(`${pair} price: ${currentPrice}`);

        if (buyPrice > currentPrice) {
          isStopEntry = true;
          response = await binance.buyAsync(pair, amount, buyLimitPrice || buyPrice, { stopPrice: buyPrice, type: 'STOP_LOSS_LIMIT', newOrderRespType: 'FULL' });
        } else {
          isLimitEntry = true;
          response = await binance.buyAsync(pair, amount, buyPrice, { type: 'LIMIT', newOrderRespType: 'FULL' });
        }
      }
    } catch (err) {
      throw new Error(err.body);
    }

    debug('Buy response: %o', response);
    debug(`order id: ${response.orderId}`);

    if (response.status !== 'FILLED') {
      await waitForBuyOrderFill(response.orderId).finally(disconnect);
    } else if (stopPrice || targetPrice) {
      calculateStopAndTargetAmounts(response.fills[0].commissionAsset);
    }
  }

  if (stopPrice && targetPrice) {
    if (targetSellAmount < stopSellAmount) {
      await placeStopOrderAsync(stopSellAmount - targetSellAmount);
      stopSellAmount = targetSellAmount;
    }

    const stopOrderId = await placeStopOrderAsync(stopSellAmount);
    await waitForSellOrderFill(stopOrderId).finally(disconnect);
  } else if (stopPrice && !targetPrice) {
    await placeStopOrderAsync(stopSellAmount);
  } else if (!stopPrice && targetPrice) {
    await placeTargetOrderAsync(targetSellAmount);
  }
};

module.exports = { binanceOco };
