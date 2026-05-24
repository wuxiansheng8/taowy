import sys
import json
from substrateinterface import SubstrateInterface

def plain_value(value):
    if hasattr(value, "value"):
        return plain_value(value.value)
    return value

def as_number(value):
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None

def main():
    print("Connecting to Bittensor...")
    endpoint = "wss://entrypoint-finney.opentensor.ai:443"
    try:
        sub = SubstrateInterface(url=endpoint)
        
        # Query maps
        print("Querying SubnetOwner...")
        owners = {int(k.value): str(v.value) for k, v in sub.query_map("SubtensorModule", "SubnetOwner")}
        print(f"Found {len(owners)} active subnets.")
        
        print("Querying NetworkRegisteredAt...")
        registered_at = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "NetworkRegisteredAt")}
        
        print("Querying SubnetAlphaIn...")
        alpha_in = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "SubnetAlphaIn")}
        
        print("Querying SubnetAlphaOut...")
        alpha_out = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "SubnetAlphaOut")}
        
        print("Querying SubnetTAO...")
        tao_in = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "SubnetTAO")}
        
        print("Querying SubnetMovingPrice...")
        moving_prices = {}
        for k, v in sub.query_map("SubtensorModule", "SubnetMovingPrice"):
            bits = int(v.value.get("bits", 0) if isinstance(v.value, dict) else v.value)
            moving_prices[int(k.value)] = bits / (2**32)
            
        print("Querying ImmunityPeriod...")
        immunity_periods = {int(k.value): int(v.value) for k, v in sub.query_map("SubtensorModule", "ImmunityPeriod")}
        
        print("Querying TokenSymbol...")
        symbols = {}
        for k, v in sub.query_map("SubtensorModule", "TokenSymbol"):
            try:
                # v.value is either bytes, list of ints, or string
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
                
        print("Querying SubnetIdentitiesV3...")
        identities = {}
        for k, v in sub.query_map("SubtensorModule", "SubnetIdentitiesV3"):
            identities[int(k.value)] = v.value
            
        # Reconstruct first 3 subnets for verification
        netuids = sorted(list(owners.keys()))
        print("\nVerification (First 3 subnets):")
        for netuid in netuids[:3]:
            owner = owners.get(netuid)
            reg_block = registered_at.get(netuid)
            a_in = alpha_in.get(netuid, 0) / 1e9
            a_out = alpha_out.get(netuid, 0) / 1e9
            t_in = tao_in.get(netuid, 0) / 1e9
            price = t_in / a_in if a_in > 0 else 0
            ema_price = moving_prices.get(netuid, 0)
            symbol = symbols.get(netuid, "S" + str(netuid))
            identity = identities.get(netuid, {})
            name = identity.get("subnet_name", "Subnet " + str(netuid))
            immunity = immunity_periods.get(netuid)
            
            print(f"\nSubnet {netuid}:")
            print(f"  Name: {name}")
            print(f"  Symbol: {symbol}")
            print(f"  Owner: {owner}")
            print(f"  Registered At Block: {reg_block}")
            print(f"  Alpha In: {a_in:.4f}")
            print(f"  Alpha Out: {a_out:.4f}")
            print(f"  TAO In: {t_in:.4f}")
            print(f"  Calculated Spot Price: {price:.6f}")
            print(f"  EMA Price: {ema_price:.6f}")
            print(f"  Immunity Period: {immunity}")
            
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
