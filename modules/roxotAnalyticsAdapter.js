import {deepClone, getParameterByName, logError, logInfo} from '../src/utils.js';
import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import { EVENTS } from '../src/constants.js';
import adapterManager from '../src/adapterManager.js';

import {ajaxBuilder} from '../src/ajax.js';
import {getStorageManager} from '../src/storageManager.js';
import {MODULE_TYPE_ANALYTICS} from '../src/activities/modules.js';

const MODULE_CODE = 'roxot';

const storage = getStorageManager({moduleType: MODULE_TYPE_ANALYTICS, moduleName: MODULE_CODE});

const ajax = ajaxBuilder(0);

const DEFAULT_EVENT_URL = 'pa.rxthdr.com/v3';
const DEFAULT_SERVER_CONFIG_URL = 'pa.rxthdr.com/v3';
const analyticsType = 'endpoint';

const {
  AUCTION_INIT,
  AUCTION_END,
  BID_REQUESTED,
  BID_ADJUSTMENT,
  BIDDER_DONE,
  BID_WON
} = EVENTS;

const AUCTION_STATUS = {
  'RUNNING': 'running',
  'FINISHED': 'finished'
};
const BIDDER_STATUS = {
  'REQUESTED': 'requested',
  'BID': 'bid',
  'NO_BID': 'noBid',
  'TIMEOUT': 'timeout'
};
const ROXOT_EVENTS = {
  'AUCTION': 'a',
  'IMPRESSION': 'i',
  'BID_AFTER_TIMEOUT': 'bat'
};

let initOptions = {};

const localStoragePrefix = 'roxot_analytics_';

const utmTags = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
const utmTtlKey = 'utm_ttl';
const utmTtl = 60 * 60 * 1000;

const isNewKey = 'is_new_flag';
const isNewTtl = 60 * 60 * 1000;

const auctionCache = {};
const auctionTtl = 60 * 60 * 1000;

const sendEventCache = [];
let sendEventTimeoutId = null;
const sendEventTimeoutTime = 1000;

function detectDevice() {
  if ((/ipad|android 3.0|xoom|sch-i800|playbook|tablet|kindle/i.test(navigator.userAgent.toLowerCase()))) {
    return 'tablet';
  }
  if ((/iphone|ipod|android|blackberry|opera|mini|windows\sce|palm|smartphone|iemobile/i.test(navigator.userAgent.toLowerCase()))) {
    return 'mobile';
  }
  return 'desktop';
}

function checkIsNewFlag() {
  const key = buildLocalStorageKey(isNewKey);
  const lastUpdate = Number(storage.getDataFromLocalStorage(key));
  storage.setDataInLocalStorage(key, Date.now());
  return Date.now() - lastUpdate > isNewTtl;
}

function updateUtmTimeout() {
  storage.setDataInLocalStorage(buildLocalStorageKey(utmTtlKey), Date.now());
}

function isUtmTimeoutExpired() {
  const utmTimestamp = storage.getDataFromLocalStorage(buildLocalStorageKey(utmTtlKey));
  return (Date.now() - utmTimestamp) > utmTtl;
}

function buildLocalStorageKey(key) {
  return localStoragePrefix.concat(key);
}

function isSupportedAdUnit(adUnit) {
  if (!initOptions.adUnits.length) {
    return true;
  }

  return initOptions.adUnits.includes(adUnit);
}

function deleteOldAuctions() {
  for (const auctionId in auctionCache) {
    const auction = auctionCache[auctionId];
    if (Date.now() - auction.start > auctionTtl) {
      delete auctionCache[auctionId];
    }
  }
}

function buildAuctionEntity(args) {
  return {
    'id': args.auctionId,
    'start': args.timestamp,
    'timeout': args.timeout,
    'adUnits': {}
  };
}

function extractAdUnitCode(args) {
  return args.adUnitCode.toLowerCase();
}

function extractBidder(args) {
  return args.bidder.toLowerCase();
}

function buildAdUnitAuctionEntity(auction, bidRequest) {
  return {
    'adUnit': extractAdUnitCode(bidRequest),
    'start': auction.start,
    'timeout': auction.timeout,
    'finish': 0,
    'status': AUCTION_STATUS.RUNNING,
    'bidders': {}
  };
}

function buildBidderRequest(auction, bidRequest) {
  return {
    'bidder': extractBidder(bidRequest),
    'isAfterTimeout': auction.status === AUCTION_STATUS.FINISHED ? 1 : 0,
    'start': bidRequest.startTime || Date.now(),
    'finish': 0,
    'status': BIDDER_STATUS.REQUESTED,
    'cpm': -1,
    'size': {
      'width': 0,
      'height': 0
    },
    'mediaType': '-',
    'source': bidRequest.source || 'client'
  };
}

function buildBidAfterTimeout(adUnitAuction, args) {
  return {
    'auction': deepClone(adUnitAuction),
    'adUnit': extractAdUnitCode(args),
    'bidder': extractBidder(args),
    'cpm': args.cpm,
    'size': {
      'width': args.width || 0,
      'height': args.height || 0
    },
    'mediaType': args.mediaType || '-',
    'start': args.requestTimestamp,
    'finish': args.responseTimestamp,
  };
}

function buildImpression(adUnitAuction, args) {
  return {
    'isNew': checkIsNewFlag() ? 1 : 0,
    'auction': deepClone(adUnitAuction),
    'adUnit': extractAdUnitCode(args),
    'bidder': extractBidder(args),
    'cpm': args.cpm,
    'size': {
      'width': args.width,
      'height': args.height
    },
    'mediaType': args.mediaType,
    'source': args.source || 'client'
  };
}

function handleAuctionInit(args) {
  auctionCache[args.auctionId] = buildAuctionEntity(args);
  deleteOldAuctions();
}

function handleBidRequested(args) {
  const auction = auctionCache[args.auctionId];
  args.bids.forEach(function (bidRequest) {
    const adUnitCode = extractAdUnitCode(bidRequest);
    const bidder = extractBidder(bidRequest);
    if (!isSupportedAdUnit(adUnitCode)) {
      return;
    }
    auction['adUnits'][adUnitCode] = auction['adUnits'][adUnitCode] || buildAdUnitAuctionEntity(auction, bidRequest);
    const adUnitAuction = auction['adUnits'][adUnitCode];
    adUnitAuction['bidders'][bidder] = adUnitAuction['bidders'][bidder] || buildBidderRequest(auction, bidRequest);
  });
}

function handleBidAdjustment(args) {
  const adUnitCode = extractAdUnitCode(args);
  const bidder = extractBidder(args);
  if (!isSupportedAdUnit(adUnitCode)) {
    return;
  }

  const adUnitAuction = auctionCache[args.auctionId]['adUnits'][adUnitCode];
  if (adUnitAuction.status === AUCTION_STATUS.FINISHED) {
    handleBidAfterTimeout(adUnitAuction, args);
    return;
  }

  const bidderRequest = adUnitAuction['bidders'][bidder];
  if (bidderRequest.cpm < args.cpm) {
    bidderRequest.cpm = args.cpm;
    bidderRequest.finish = args.responseTimestamp;
    bidderRequest.status = args.cpm === 0 ? BIDDER_STATUS.NO_BID : BIDDER_STATUS.BID;
    bidderRequest.size.width = args.width || 0;
    bidderRequest.size.height = args.height || 0;
    bidderRequest.mediaType = args.mediaType || '-';
    bidderRequest.source = args.source || 'client';
  }
}

function handleBidAfterTimeout(adUnitAuction, args) {
  const bidder = extractBidder(args);
  const bidderRequest = adUnitAuction['bidders'][bidder];
  const bidAfterTimeout = buildBidAfterTimeout(adUnitAuction, args);

  if (bidAfterTimeout.cpm > bidderRequest.cpm) {
    bidderRequest.cpm = bidAfterTimeout.cpm;
    bidderRequest.isAfterTimeout = 1;
    bidderRequest.finish = bidAfterTimeout.finish;
    bidderRequest.size = bidAfterTimeout.size;
    bidderRequest.mediaType = bidAfterTimeout.mediaType;
    bidderRequest.status = bidAfterTimeout.cpm === 0 ? BIDDER_STATUS.NO_BID : BIDDER_STATUS.BID;
  }

  registerEvent(ROXOT_EVENTS.BID_AFTER_TIMEOUT, 'Bid After Timeout', bidAfterTimeout);
}

function handleBidderDone(args) {
  const auction = auctionCache[args.auctionId];

  args.bids.forEach(function (bidDone) {
    const adUnitCode = extractAdUnitCode(bidDone);
    const bidder = extractBidder(bidDone);
    if (!isSupportedAdUnit(adUnitCode)) {
      return;
    }

    const adUnitAuction = auction['adUnits'][adUnitCode];
    if (adUnitAuction.status === AUCTION_STATUS.FINISHED) {
      return;
    }
    const bidderRequest = adUnitAuction['bidders'][bidder];
    if (bidderRequest.status !== BIDDER_STATUS.REQUESTED) {
      return;
    }

    bidderRequest.finish = Date.now();
    bidderRequest.status = BIDDER_STATUS.NO_BID;
    bidderRequest.cpm = 0;
  });
}

function handleAuctionEnd(args) {
  const auction = auctionCache[args.auctionId];
  if (!Object.keys(auction.adUnits).length) {
    delete auctionCache[args.auctionId];
  }

  const finish = Date.now();
  auction.finish = finish;
  for (const adUnit in auction.adUnits) {
    const adUnitAuction = auction.adUnits[adUnit];
    adUnitAuction.finish = finish;
    adUnitAuction.status = AUCTION_STATUS.FINISHED;

    for (const bidder in adUnitAuction.bidders) {
      const bidderRequest = adUnitAuction.bidders[bidder];
      if (bidderRequest.status !== BIDDER_STATUS.REQUESTED) {
        continue;
      }

      bidderRequest.status = BIDDER_STATUS.TIMEOUT;
    }
  }

  registerEvent(ROXOT_EVENTS.AUCTION, 'Auction', auction);
}

function handleBidWon(args) {
  const adUnitCode = extractAdUnitCode(args);
  if (!isSupportedAdUnit(adUnitCode)) {
    return;
  }
  const adUnitAuction = auctionCache[args.auctionId]['adUnits'][adUnitCode];
  const impression = buildImpression(adUnitAuction, args);
  registerEvent(ROXOT_EVENTS.IMPRESSION, 'Bid won', impression);
}

function handleOtherEvents(eventType, args) {
  registerEvent(eventType, eventType, args);
}

const roxotAdapter = Object.assign(adapter({url: DEFAULT_EVENT_URL, analyticsType}), {
  track({eventType, args}) {
    switch (eventType) {
      case AUCTION_INIT:
        handleAuctionInit(args);
        break;
      case BID_REQUESTED:
        handleBidRequested(args);
        break;
      case BID_ADJUSTMENT:
        handleBidAdjustment(args);
        break;
      case BIDDER_DONE:
        handleBidderDone(args);
        break;
      case AUCTION_END:
        handleAuctionEnd(args);
        break;
      case BID_WON:
        handleBidWon(args);
        break;
      default:
        handleOtherEvents(eventType, args);
        break;
    }
  },

});

roxotAdapter.originEnableAnalytics = roxotAdapter.enableAnalytics;

roxotAdapter.enableAnalytics = function (config) {
  if (this.initConfig(config)) {
    _logInfo('Analytics adapter enabled', initOptions);
    roxotAdapter.originEnableAnalytics(config);
  }
};

roxotAdapter.buildUtmTagData = function () {
  const utmTagData = {};
  let utmTagsDetected = false;
  utmTags.forEach(function (utmTagKey) {
    const utmTagValue = getParameterByName(utmTagKey);
    if (utmTagValue !== '') {
      utmTagsDetected = true;
    }
    utmTagData[utmTagKey] = utmTagValue;
  });
  utmTags.forEach(function (utmTagKey) {
    if (utmTagsDetected) {
      storage.setDataInLocalStorage(buildLocalStorageKey(utmTagKey), utmTagData[utmTagKey]);
      updateUtmTimeout();
    } else {
      if (!isUtmTimeoutExpired()) {
        utmTagData[utmTagKey] = storage.getDataFromLocalStorage(buildLocalStorageKey(utmTagKey)) ? storage.getDataFromLocalStorage(buildLocalStorageKey(utmTagKey)) : '';
        updateUtmTimeout();
      }
    }
  });
  return utmTagData;
};

roxotAdapter.initConfig = function (config) {
  let isCorrectConfig = true;
  initOptions = {};
  initOptions.options = deepClone(config.options);

  initOptions.publisherId = initOptions.options.publisherId || (initOptions.options.publisherIds[0]) || null;
  if (!initOptions.publisherId) {
    _logError('"options.publisherId" is empty');
    isCorrectConfig = false;
  }

  initOptions.adUnits = initOptions.options.adUnits || [];
  initOptions.adUnits = initOptions.adUnits.map(value => value.toLowerCase());
  initOptions.server = initOptions.options.server || DEFAULT_EVENT_URL;
  initOptions.configServer = initOptions.options.configServer || (initOptions.options.server || DEFAULT_SERVER_CONFIG_URL);
  initOptions.utmTagData = this.buildUtmTagData();
  initOptions.host = initOptions.options.host || window.location.hostname;
  initOptions.device = detectDevice();

  loadServerConfig();
  return isCorrectConfig;
};

roxotAdapter.getOptions = function () {
  return initOptions;
};

function registerEvent(eventType, eventName, data) {
  const eventData = {
    eventType: eventType,
    eventName: eventName,
    data: data
  };

  sendEventCache.push(eventData);

  _logInfo('Register event', eventData);

  (typeof initOptions.serverConfig === 'undefined') ? checkEventAfterTimeout() : checkSendEvent();
}

function checkSendEvent() {
  if (sendEventTimeoutId) {
    clearTimeout(sendEventTimeoutId);
    sendEventTimeoutId = null;
  }

  if (typeof initOptions.serverConfig === 'undefined') {
    checkEventAfterTimeout();
    return;
  }

  while (sendEventCache.length) {
    const event = sendEventCache.shift();
    const isNeedSend = initOptions.serverConfig[event.eventType] || 0;
    if (Number(isNeedSend) === 0) {
      _logInfo('Skip event ' + event.eventName, event);
      continue;
    }
    sendEvent(event.eventType, event.eventName, event.data);
  }
}

function checkEventAfterTimeout() {
  if (sendEventTimeoutId) {
    return;
  }

  sendEventTimeoutId = setTimeout(checkSendEvent, sendEventTimeoutTime);
}

function sendEvent(eventType, eventName, data) {
  const url = 'https://' + initOptions.server + '/' + eventType + '?publisherId=' + initOptions.publisherId + '&host=' + initOptions.host;
  const eventData = {
    'event': eventType,
    'eventName': eventName,
    'options': initOptions,
    'data': data
  };

  ajax(
    url,
    function () {
      _logInfo(eventName + ' sent', eventData);
    },
    JSON.stringify(eventData),
    {
      contentType: 'text/plain',
      method: 'POST',
      withCredentials: true
    }
  );
}

function loadServerConfig() {
  const url = 'https://' + initOptions.configServer + '/c' + '?publisherId=' + initOptions.publisherId + '&host=' + initOptions.host;
  ajax(
    url,
    {
      'success': function (data) {
        initOptions.serverConfig = JSON.parse(data);
      },
      'error': function () {
        initOptions.serverConfig = {};
        initOptions.serverConfig[ROXOT_EVENTS.AUCTION] = 1;
        initOptions.serverConfig[ROXOT_EVENTS.IMPRESSION] = 1;
        initOptions.serverConfig[ROXOT_EVENTS.BID_AFTER_TIMEOUT] = 1;
        initOptions.serverConfig['isError'] = 1;
      }
    },
    null,
    {
      contentType: 'text/json',
      method: 'GET',
      withCredentials: true
    }
  );
}

function _logInfo(message, meta) {
  logInfo(buildLogMessage(message), meta);
}

function _logError(message) {
  logError(buildLogMessage(message));
}

function buildLogMessage(message) {
  return 'Roxot Prebid Analytics: ' + message;
}

adapterManager.registerAnalyticsAdapter({
  adapter: roxotAdapter,
  code: MODULE_CODE,
});

export default roxotAdapter;
