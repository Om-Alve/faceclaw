# Connect Terminal to a Rex server

Faceclaw's Terminal app opens the panes of a [Rex](https://www.superlogical.com/rex/) server on a Mac or Linux machine. The phone reaches the server over your tailnet, through the Tailscale node built into Rex. The machine does not need Tailscale installed.

Run the `rex` commands below on the machine that runs the Rex server.

## Prepare the tailnet

The Rex node gets an `https://` address, such as `https://rex.tail1234.ts.net`. Tailscale serves that address only if the tailnet allows it.

1. In the Tailscale admin console, turn on MagicDNS.
2. In the same console, turn on HTTPS certificates.
3. On the phone, sign in to Tailscale with the same account that you use for the Rex node.

## Turn on Tailscale in Rex

1. Turn on the Rex node:

	```sh
	rex server tailscale on
	```

2. Show the server status:

	```sh
	rex server status
	```

	The first time, the output holds a sign-in link. Open the link in a browser and sign in. Rex keeps the login, so you sign in only once.

3. Run `rex server status` again. Continue when the `tailscale` line shows `running`.

`rex server tailscale on` lasts until the server stops. To turn Tailscale on each time the server starts, start the server with `--tailscale`:

```sh
rex server start --tailscale
```

`rex server start` changes nothing if a server is already running. To restart a running server, run `rex server stop` first. Stopping the server ends every program that runs in its sessions.

On Linux, if `rex server install` set up the server, systemd starts it. Add `--tailscale` to the server's command line in a drop-in file. To edit the drop-in file, run `systemctl --user edit rex.service`.

## Add the server to Terminal

1. Show the pairing QR code:

	```sh
	rex server tailscale pair
	```

	The code holds only the server's `https://` address. If the command says that Tailscale HTTPS is not ready yet, wait a few seconds and run it again.

2. In Faceclaw, open Terminal and add a connection.
3. Choose **Scan QR** and scan the code.

To type the address instead, enter the `https://` address that `rex server tailscale pair` prints under the code.

## Fix a failed connection

If Terminal shows `Rex refused this device`, the phone's Tailscale account is not the account that owns the Rex node. Sign the phone in to that account. To let in every account that your tailnet's access rules allow, run `rex server tailscale off`, then `rex server tailscale on --allow-tailnet-members`.

If Terminal shows `Can't reach` and the host name, turn on Tailscale on the phone. Then check that the `tailscale` line of `rex server status` shows `running`.

## Connect over USB for development

A relay on your computer can forward a port to the local Rex socket. The phone then reaches the relay over USB, with no tailnet.

1. In the Faceclaw checkout, start the relay:

	```sh
	node scripts/rex-relay.mjs --port 8792
	```

2. Forward the phone's port to the relay:

	```sh
	adb reverse tcp:8792 tcp:8792
	```

3. In Terminal, add the connection `rex://127.0.0.1:8792`.
