import sys
from substrateinterface import SubstrateInterface

def main():
    endpoint = "wss://entrypoint-finney.opentensor.ai:443"
    sub = SubstrateInterface(url=endpoint)
    
    # We will list a few key storage functions and print their key and value types
    storage_funcs = [
        "Keys",
        "Uids",
        "TotalHotkeyAlpha",
        "SubnetOwner",
        "Neurons"
    ]
    
    for func in storage_funcs:
        try:
            f = sub.get_metadata_storage_function("SubtensorModule", func)
            print(f"\nFunction: {func}")
            print(f"  Type: {f.type}")
            # print modifier, documentation, etc.
            if hasattr(f, 'type') and hasattr(f.type, 'value'):
                t = f.type.value
                if 'Map' in f.type.name:
                    print(f"  Keys: {t.get('hashers') or t.get('key')}")
                    print(f"  Value: {t.get('value')}")
        except Exception as e:
            print(f"Error for {func}: {e}")

if __name__ == "__main__":
    main()
