import sys
from substrateinterface import SubstrateInterface

def rpc_request(sub, method, params=None):
    try:
        result = sub.rpc_request(method=method, params=params or [])
        if isinstance(result, dict) and "result" in result:
            return result["result"]
        return result
    except Exception as e:
        print(f"RPC error for {method}: {e}")
        return None

def main():
    endpoint = "wss://entrypoint-finney.opentensor.ai:443"
    try:
        sub = SubstrateInterface(url=endpoint)
        subnets_info = rpc_request(sub, "subnetInfo_getSubnetsInfo")
        print(f"Type: {type(subnets_info)}")
        if isinstance(subnets_info, str):
            print(f"String starts with: {subnets_info[:100]}")
            print(f"String length: {len(subnets_info)}")
        else:
            print(f"Output: {subnets_info}")
    except Exception as e:
        print(f"Error occurred: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
