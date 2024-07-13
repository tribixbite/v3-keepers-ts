import {
  RpcDataFilter,
  Umi,
  RpcAccount,
  deserializeAccount,
  RpcDataFilterMemcmp,
} from "@metaplex-foundation/umi";
import { publicKey } from "@metaplex-foundation/umi-public-keys";
import { MarginAccount, PARCL_V3_PROGRAM_ID, ProgramAccount } from "@parcl-oss/v3-sdk";
import {
  discriminatorFilter,
  marginAccountFilter,
  marginAccountSerializer,
} from "./marginAccounts";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { calculateDuration } from "./dateTime";

export async function getProgramAccountsAndRemoveDiscriminators(
  filters: RpcDataFilter[] = [discriminatorFilter],
  umi: Umi
): Promise<RpcAccount[]> {
  const rawAccounts = await umi.rpc.getProgramAccounts(publicKey(PARCL_V3_PROGRAM_ID), {
    filters: [...filters, marginAccountFilter],
  });

  const rawAccountsNoDisc = [];
  for (const rawAccount of rawAccounts) {
    rawAccount.data.copyWithin(0, 8);
    rawAccountsNoDisc.push(rawAccount);
  }
  return rawAccountsNoDisc;
}

export async function getAccountClone(
  rpcUrl: string,
  filters: RpcDataFilterMemcmp[] = [discriminatorFilter]
): Promise<ProgramAccount<MarginAccount>[]> {
  const umi = createUmi(rpcUrl);
  const startTime = performance.now();
  const rawAccounts = await getProgramAccountsAndRemoveDiscriminators(filters, umi);
  const endTime = performance.now();

  console.log(
    `getProgramAccountsAndRemoveDiscriminators in ${calculateDuration(startTime, endTime)}`
  );
  const converted = rawAccounts.map((rawAccount) => ({
    address: rawAccount.publicKey,
    account: deserializeAccount(rawAccount, marginAccountSerializer), //Serializer<MarginAccount>),
  }));
  return converted;
}
