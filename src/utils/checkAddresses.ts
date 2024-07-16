import type { Commitment } from "@metaplex-foundation/umi";
import {
  Address,
  Exchange,
  MarketMap,
  PriceFeedMap,
  ParclV3Sdk,
  MarginAccountWrapper,
  ExchangeWrapper,
} from "@parcl-oss/v3-sdk";
import { Keypair } from "@solana/web3.js";
import { decode, encode } from "bs58";
import {
  Liquidator,
  getActiveMarginAccounts,
  HighRiskStore,
  calculateLiquidationProximityScore,
} from "./marginAccounts";
import { liquidate } from "./liquidate";

export async function checkAddresses(
  rpcUrl: string,
  addresses: Address[],
  liquidator: Liquidator,
  marketData: {
    exchange: Exchange;
    dataMaps: [MarketMap, PriceFeedMap];
  },
  log: boolean = false,
  tryLiquidate?: Address
) {
  const commitment: Commitment = "confirmed";
  const sdk = new ParclV3Sdk({ rpcUrl, commitment });
  const { exchange, dataMaps } = marketData;
  const [markets, priceFeeds] = dataMaps;
  const { liquidatorMarginAccount, privateKeyString } = liquidator;
  const lookupLimit = process.env.LOOKUP_LIMIT;
  const liquidatorSigner = Keypair.fromSecretKey(decode(privateKeyString));

  const threshhold = parseInt(process.env.THRESHHOLD ?? "75");

  const limit = lookupLimit ? parseInt(lookupLimit) : undefined;
  const addressesToGet = addresses.slice(0, limit);

  const activeMarginAccounts = await getActiveMarginAccounts(rpcUrl, addressesToGet, log);

  const highRiskStore: HighRiskStore[] = [];
  for (const rawMarginAccount of activeMarginAccounts) {
    const marginAccount = new MarginAccountWrapper(
      rawMarginAccount.account,
      rawMarginAccount.address
    );
    const accounts = {
      marginAccount: rawMarginAccount.address,
      exchange: rawMarginAccount.account.exchange,
      owner: rawMarginAccount.account.owner,
      liquidator: liquidatorSigner.publicKey,
      liquidatorMarginAccount,
    };
    if (tryLiquidate && marginAccount.address === tryLiquidate) {
      console.log(`Attempting to liquidate ${marginAccount.address}`);
      await liquidate(sdk, marginAccount, accounts, markets, encode(liquidatorSigner.secretKey), {
        ignoreSimulationFailure: true,
        isFullLiquidation: true,
      });
    }
    if (marginAccount.inLiquidation()) {
      console.log(`Liquidating account already in liquidation (${marginAccount.address})`);
      await liquidate(sdk, marginAccount, accounts, markets, encode(liquidatorSigner.secretKey), {
        ignoreSimulationFailure: true,
        isFullLiquidation: false,
      });
      continue;
    }
    const margins = marginAccount.getAccountMargins(
      new ExchangeWrapper(exchange),
      markets,
      priceFeeds,
      Math.floor(Date.now() / 1000)
    );
    if (margins.canLiquidate()) {
      console.log(`Starting liquidation for ${marginAccount.address}`);
      const signature = await liquidate(
        sdk,
        marginAccount,
        accounts,
        markets,
        encode(liquidatorSigner.secretKey),
        {
          ignoreSimulationFailure: true,
          isFullLiquidation: true,
        }
      );
      console.log("Signature: ", signature);
    }
    const liquidationProximity = calculateLiquidationProximityScore(margins);
    if (
      liquidationProximity > threshhold
      // && !highRiskStore.find((a) => a.address === rawMarginAccount.address)
    ) {
      highRiskStore.push({
        address: rawMarginAccount.address,
        score: liquidationProximity,
      });
    }
  }
  return highRiskStore;
}
