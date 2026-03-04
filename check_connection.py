"""
Quick diagnostic script to check if the agent server is working
"""

import asyncio
import aiohttp

async def check_http_endpoint():
    """Check if HTTP endpoint is working"""
    print("1. Checking HTTP endpoint...")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get('http://localhost:5005/health', timeout=5) as response:
                if response.status == 200:
                    data = await response.json()
                    print(f"   ✅ HTTP endpoint working!")
                    print(f"   Response: {data}")
                    return True
                else:
                    print(f"   ❌ HTTP endpoint returned status {response.status}")
                    return False
    except asyncio.TimeoutError:
        print("   ❌ HTTP endpoint timeout - server might be starting")
        return False
    except aiohttp.ClientConnectorError:
        print("   ❌ Cannot connect - server is not running!")
        print("   💡 Start the server with: python agent_server.py")
        return False
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False


async def check_websocket():
    """Check if WebSocket endpoint is working"""
    print("\n2. Checking WebSocket endpoint...")
    try:
        import websockets

        uri = "ws://localhost:5005/ws/chat/test_session"
        print(f"   Connecting to: {uri}")

        async with websockets.connect(uri, timeout=5) as websocket:
            print("   ✅ WebSocket connection successful!")

            # Try to send a test message
            await websocket.send('{"message": "test"}')
            print("   ✅ Test message sent!")

            # Wait for response
            try:
                response = await asyncio.wait_for(websocket.recv(), timeout=2)
                print(f"   ✅ Received response: {response[:100]}...")
            except asyncio.TimeoutError:
                print("   ⚠️  No response received (might be normal)")

            return True

    except ImportError:
        print("   ⚠️  websockets package not installed")
        print("   Install with: pip install websockets")
        return False
    except asyncio.TimeoutError:
        print("   ❌ WebSocket connection timeout")
        return False
    except ConnectionRefusedError:
        print("   ❌ WebSocket connection refused - server not running!")
        return False
    except Exception as e:
        print(f"   ❌ WebSocket error: {e}")
        return False


async def check_non_streaming_endpoint():
    """Check if non-streaming chat endpoint works"""
    print("\n3. Checking non-streaming chat endpoint...")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                'http://localhost:5005/chat',
                json={"message": "hello", "session_id": "test"},
                timeout=10
            ) as response:
                if response.status == 200:
                    data = await response.json()
                    print(f"   ✅ Chat endpoint working!")
                    print(f"   Response: {data}")
                    return True
                else:
                    print(f"   ❌ Chat endpoint returned status {response.status}")
                    text = await response.text()
                    print(f"   Response: {text[:200]}")
                    return False
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False


async def main():
    print("=" * 60)
    print("Agent Server Connection Diagnostics")
    print("=" * 60)

    # Check HTTP first
    http_ok = await check_http_endpoint()

    if not http_ok:
        print("\n" + "=" * 60)
        print("❌ Server is not running!")
        print("=" * 60)
        print("\nTo fix:")
        print("1. Open a new terminal")
        print("2. Run: python agent_server.py")
        print("3. Wait for 'Uvicorn running on http://127.0.0.1:5005'")
        print("4. Run this diagnostic script again")
        return

    # Check WebSocket
    ws_ok = await check_websocket()

    # Check non-streaming endpoint
    chat_ok = await check_non_streaming_endpoint()

    print("\n" + "=" * 60)
    print("Summary:")
    print("=" * 60)
    print(f"HTTP Health Check: {'✅ PASS' if http_ok else '❌ FAIL'}")
    print(f"WebSocket:         {'✅ PASS' if ws_ok else '❌ FAIL'}")
    print(f"Chat Endpoint:     {'✅ PASS' if chat_ok else '❌ FAIL'}")

    if http_ok and ws_ok:
        print("\n✅ All checks passed! Extension should work now.")
        print("\nTry:")
        print("1. Reload your Chrome extension")
        print("2. Send a message in the chat")
    else:
        print("\n❌ Some checks failed. Please fix the issues above.")


if __name__ == "__main__":
    asyncio.run(main())
