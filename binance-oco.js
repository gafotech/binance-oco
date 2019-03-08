const debug = require('debug')('binance-oco');
const Binance = require('./lib/node-binance-api-async');

const binanceOco = options => new Promise((resolve, reject) => {
  const {
    pair,
    nonBnbFees,
  } = options;

  let {
    amount, buyPrice, buyLimitPrice, stopPrice, limitPrice, targetPrice, cancelPrice,
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

  let stopSellAmount = amount;
  let targetSellAmount = scaleOutAmount || amount;

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
        disconnect();
        reject(new Error(err.body));
      } finally {
        isCancelling = false;
      }
    }
  };

  let stopOrderId = 0;
  let targetOrderId = 0;

  const placeStopOrderAsync = async () => {
    try {
      const response = await binance.sellAsync(pair, stopSellAmount, limitPrice || stopPrice, { stopPrice, type: 'STOP_LOSS_LIMIT', newOrderRespType: 'FULL' });

      debug('Sell response: %o', response);
      debug(`order id: ${response.orderId}`);

      if (targetPrice) {
        stopOrderId = response.orderId;
      } else {
        disconnect();
        resolve();
      }
    } catch (err) {
      disconnect();
      reject(new Error(err.body));
    }
  };

  const placeTargetOrderAsync = async () => {
    try {
      const response = await binance.sellAsync(pair, targetSellAmount, targetPrice, { type: 'LIMIT', newOrderRespType: 'FULL' });

      debug('Sell response: %o', response);
      debug(`order id: ${response.orderId}`);

      if (stopPrice) {
        targetOrderId = response.orderId;

        if (targetSellAmount !== stopSellAmount) {
          stopSellAmount -= targetSellAmount;
          await placeStopOrderAsync();
        }
      } else {
        disconnect();
        resolve();
      }
    } catch (err) {
      disconnect();
      reject(new Error(err.body));
    }
  };

  const isOrderFilled = (data) => {
    const {
      s: symbol, p: price, q: quantity, S: side, o: orderType, i: orderId, X: orderStatus,
    } = data;

    debug(`${symbol} ${side} ${orderType} ORDER #${orderId} (${orderStatus})`);
    debug(`..price: ${price}, quantity: ${quantity}`);

    if (orderStatus === 'NEW' || orderStatus === 'PARTIALLY_FILLED') {
      return false;
    }

    if (orderStatus !== 'FILLED') {
      disconnect();
      reject(new Error(`Order ${orderStatus}. Reason: ${data.r}`));
      return false;
    }

    return true;
  };

  const placeSellOrderAsync = async () => {
    try {
      if (stopPrice) {
        await placeStopOrderAsync();
      } else if (targetPrice) {
        await placeTargetOrderAsync();
      } else {
        disconnect();
        resolve();
      }
    } catch (err) {
      disconnect();
      reject(err);
    }
  };

  let buyOrderId = 0;
  let isLimitEntry = false;
  let isStopEntry = false;

  const tradesCallback = async (trades) => {
    try {
      const { s: symbol, p: price } = trades;
      if (buyOrderId) {
        if (!cancelPrice) {
          debug(`${symbol} trade update. price: ${price} buy: ${buyPrice}`);
        } else {
          debug(`${symbol} trade update. price: ${price} buy: ${buyPrice} cancel: ${cancelPrice}`);

          if (((isStopEntry && price <= cancelPrice)
            || (isLimitEntry && price >= cancelPrice))
            && !isCancelling) {
            await cancelOrderAsync(symbol, buyOrderId);
            disconnect();
            resolve();
          }
        }
      } else if (stopOrderId || targetOrderId) {
        debug(`${symbol} trade update. price: ${price} stop: ${stopPrice} target: ${targetPrice}`);
        if (stopOrderId && !targetOrderId && price >= targetPrice && !isCancelling) {
          await cancelOrderAsync(symbol, stopOrderId);
          stopOrderId = 0;
          await placeTargetOrderAsync();
        } else if (targetOrderId && !stopOrderId && price <= stopPrice && !isCancelling) {
          await cancelOrderAsync(symbol, targetOrderId);
          targetOrderId = 0;
          if (targetSellAmount !== stopSellAmount) {
            stopSellAmount += targetSellAmount;
          }
          await placeStopOrderAsync();
        }
      }
    } catch (err) {
      disconnect();
      if (err.body) {
        reject(new Error(err.body));
      } else {
        reject(err);
      }
    }
  };

  const executionCallback = async (data) => {
    const { i: orderId } = data;
    if (orderId === buyOrderId && isOrderFilled(data)) {
      buyOrderId = 0;
      const { N: commissionAsset } = data;
      calculateStopAndTargetAmounts(commissionAsset);
      await placeSellOrderAsync();
    } else if (orderId === stopOrderId || orderId === targetOrderId) {
      if (isOrderFilled(data)) {
        disconnect();
        resolve();
      }
    }
  };

  (async () => {
    try {
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
      }

      if (buyPrice) {
        buyPrice = binance.roundTicks(buyPrice, tickSize);

        if (buyLimitPrice) {
          buyLimitPrice = binance.roundTicks(buyLimitPrice, tickSize);
        }

        if (buyPrice < minPrice) {
          throw new Error(`Buy price ${buyPrice} does not meet minimum order price ${minPrice}.`);
        }

        if (buyPrice * amount < minNotional) {
          throw new Error(`Buy order does not meet minimum order value ${minNotional}.`);
        }
      }

      if (stopPrice) {
        stopPrice = binance.roundTicks(stopPrice, tickSize);

        if (limitPrice) {
          limitPrice = binance.roundTicks(limitPrice, tickSize);

          if (limitPrice < minPrice) {
            throw new Error(`Limit price ${limitPrice} does not meet minimum order price ${minPrice}.`);
          }

          if (limitPrice * stopSellAmount < minNotional) {
            throw new Error(`Stop order does not meet minimum order value ${minNotional}.`);
          }
        } else {
          if (stopPrice < minPrice) {
            throw new Error(`Stop price ${stopPrice} does not meet minimum order price ${minPrice}.`);
          }

          if (stopPrice * stopSellAmount < minNotional) {
            throw new Error(`Stop order does not meet minimum order value ${minNotional}.`);
          }
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

        const remainingAmount = amount - targetSellAmount;
        if (remainingAmount && stopPrice) {
          if (remainingAmount < minQty) {
            throw new Error(`Stop amount after scale out (${remainingAmount}) will not meet minimum order amount ${minQty}.`);
          }

          if (stopPrice * remainingAmount < minNotional) {
            throw new Error(`Stop order after scale out will not meet minimum order value ${minNotional}.`);
          }
        }
      }

      if (cancelPrice) {
        cancelPrice = binance.roundTicks(cancelPrice, tickSize);
      }

      binance.websockets.userData(() => { }, executionCallback);
      binance.websockets.trades(pair, tradesCallback);

      if (buyPrice >= 0) {
        let response;
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

        buyOrderId = response.orderId;

        debug('Buy response: %o', response);
        debug(`order id: ${response.orderId}`);

        if (response.status === 'FILLED') {
          calculateStopAndTargetAmounts(response.fills[0].commissionAsset);
          await placeSellOrderAsync();
        }
      } else {
        await placeSellOrderAsync();
      }
    } catch (err) {
      disconnect();
      if (err.body) {
        reject(new Error(err.body));
      } else {
        reject(err);
      }
    }
  })();
});

module.exports = { binanceOco };
