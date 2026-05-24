#!/usr/bin/env python3
import argparse
import json
import sys
from substrateinterface import SubstrateInterface

def plain_value(value):
    if hasattr(value, "value"):
        return plain_value(value.value)
    return value

def as_number(value):
    if value is None:
        return None
    if hasattr(value, "tao"):
        return float(value.tao)
    if hasattr(value, "value"):
        return as_number(value.value)
    try:
        return float(value)
    except Exception:
        try:
            return float(str(value).replace(",", ""))
        except Exception:
            return None

def rpc_request(sub, method, params=None):
    try:
        result = sub.rpc_request(method=method, params=params or [])
        if isinstance(result, dict) and "result" in result:
            return result["result"]
        return result
    except Exception:
        return None

def get_field(obj, *keys, default=None):
    for key in keys:
        if isinstance(obj, dict):
            if key in obj:
                return obj[key]
        else:
            if hasattr(obj, key):
                val = getattr(obj, key)
                if val is not None:
                    return val
    return default

def get_network_immunity_period(sub):
    for storage_name in ("NetworkImmunityPeriod", "SubnetImmunityPeriod"):
        try:
            value = sub.query("SubtensorModule", storage_name)
            if value is not None:
                parsed = as_number(value)
                if parsed is not None:
                    return int(parsed)
        except Exception:
            pass
    for method in ("subnetInfo_getNetworkImmunityPeriod", "subnetInfo_getSubnetImmunityPeriod"):
        value = rpc_request(sub, method)
        parsed = as_number(value)
        if parsed is not None:
            return int(parsed)
    return 864000

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--block-time-ms", type=int, default=12000)
    args = parser.parse_args()

    try:
        sub = SubstrateInterface(url=args.endpoint)
        current_block = sub.get_block_number(sub.get_chain_head())

        try:
            registration_cost = as_number(rpc_request(sub, "subnetInfo_getLockCost"))
        except Exception:
            registration_cost = None

        print("Collecting subtensor maps...", file=sys.stderr)
        
        # Query maps
        owners = {int(k.value): str(v.value) for k, v in sub.query_map("SubtensorModule", "SubnetOwner")}
        registered_at = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "NetworkRegisteredAt")}
        alpha_in = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "SubnetAlphaIn")}
        alpha_out = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "SubnetAlphaOut")}
        tao_in = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "SubnetTAO")}
        
        moving_prices = {}
        for k, v in sub.query_map("SubtensorModule", "SubnetMovingPrice"):
            bits = int(v.value.get("bits", 0) if isinstance(v.value, dict) else v.value)
            moving_prices[int(k.value)] = bits / (2**32)
            
        immunity_periods = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "ImmunityPeriod")}
        tempos = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "Tempo")}
        volumes = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "SubnetVolume")}
        
        symbols = {}
        for k, v in sub.query_map("SubtensorModule", "TokenSymbol"):
            try:
                val = v.value
                if isinstance(val, bytes):
                    symbol = val.decode('utf-8', errors='ignore')
                elif isinstance(val, list):
                    symbol = bytes(val).decode('utf-8', errors='ignore')
                elif isinstance(val, str) and val.startswith("0x"):
                    symbol = bytes.fromhex(val[2:]).decode('utf-8', errors='ignore')
                else:
                    symbol = str(val)
                symbols[int(k.value)] = symbol
            except Exception:
                symbols[int(k.value)] = "S" + str(k.value)
                
        identities = {}
        for k, v in sub.query_map("SubtensorModule", "SubnetIdentitiesV3"):
            identities[int(k.value)] = v.value

        network_immunity_period = get_network_immunity_period(sub)
        next_prune = rpc_request(sub, "subnetInfo_getSubnetToPrune")
        if isinstance(next_prune, str):
            try:
                next_prune = int(next_prune, 16) if next_prune.startswith("0x") else int(next_prune)
            except Exception:
                pass

        subnets = []
        for netuid in sorted(owners.keys()):
            if netuid == 0:
                continue
                
            identity = identities.get(netuid, {})
            name = identity.get("subnet_name")
            if not name:
                name = f"Subnet {netuid}"
                
            # Convert units (Planck/Rao -> TAO)
            a_in = alpha_in.get(netuid, 0) / 1e9
            a_out = alpha_out.get(netuid, 0) / 1e9
            t_in = tao_in.get(netuid, 0) / 1e9
            price = t_in / a_in if a_in > 0 else 0.0
            
            subnets.append({
                "netuid": netuid,
                "name": name,
                "alphaPrice": price,
                "emaPrice": moving_prices.get(netuid, 0.0),
                "registrationCost": registration_cost,
                "registrationBlock": registered_at.get(netuid),
                "immunityPeriod": network_immunity_period,
                "minerImmunityPeriod": immunity_periods.get(netuid, 7200),
                "rawVolume": volumes.get(netuid, 0) / 1e9,
                "volume24h": None,
                "volume1h": None,
                "symbol": symbols.get(netuid, f"S{netuid}"),
                "tempo": tempos.get(netuid, 99),
                "lastStep": None,
                "alphaIn": a_in,
                "alphaOut": a_out,
                "taoIn": t_in,
                "alphaStaked": None
            })

        output = {
            "currentBlock": current_block,
            "registrationCost": registration_cost,
            "immunityPeriod": network_immunity_period,
            "nextPruneCandidate": next_prune,
            "subnets": subnets
        }
        print(json.dumps(output, ensure_ascii=False))
        try:
            sub.close()
        except Exception:
            pass
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
