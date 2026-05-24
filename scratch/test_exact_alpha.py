import sys
import time
from substrateinterface import SubstrateInterface

def plain_value(value):
    if hasattr(value, "value"):
        return plain_value(value.value)
    return value

def alpha_storage_as_number(value):
    raw = plain_value(value)
    try:
        return float(raw) / 1e9
    except Exception:
        return 0.0

def main():
    endpoint = "wss://entrypoint-finney.opentensor.ai:443"
    sub = SubstrateInterface(url=endpoint)
    
    print("Testing get_exact_alpha_staked for netuid 116...")
    start = time.time()
    
    netuid = 116
    keys = sub.query_map(
        module="SubtensorModule",
        storage_function="Keys",
        params=[netuid],
    )
    
    print(f"Time to query_map: {time.time() - start:.3f}s")
    
    storage_keys = []
    for _uid, hotkey in keys:
        storage_keys.append(
            sub.create_storage_key(
                pallet="SubtensorModule",
                storage_function="TotalHotkeyAlpha",
                params=[plain_value(hotkey), netuid]
            )
        )
        
    print(f"Time to construct keys ({len(storage_keys)} keys): {time.time() - start:.3f}s")
    
    if storage_keys:
        results = sub.query_multi(storage_keys)
        total = 0.0
        for key, val in results:
            if val is not None:
                total += alpha_storage_as_number(val)
        print(f"Total Alpha Staked: {total}")
        
    print(f"Total time: {time.time() - start:.3f}s")

if __name__ == "__main__":
    main()
