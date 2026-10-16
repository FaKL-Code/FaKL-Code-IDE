---
titulo: 'SSH and Hostinger'
descricao: 'SSH servers in the workspace, policies for agents, and the Hostinger account.'
ordem: 8
---

## SSH

The **Servers** sidebar lists the hosts in your `~/.ssh/config`. Your keys and ssh-agent apply; nothing is installed on the server.

- **Add SSH server to the workspace** puts a remote folder next to the local folders, in the same window.
- **Terminal in the remote folder** opens a terminal already in it.
- **Run command on the host** executes a one-off command.
- **Agent policy on the host** defines what agents can do on each server.
- **New SSH host**, **Generate SSH key**, and **Edit ~/.ssh/config** help with setup.

Agents started in a window with a remote folder receive that folder and use SSH tools. Agents' SSH commands always ask for your approval.

## Hostinger

Connect with **Connect to Hostinger**. You can:

- restart and snapshot a VPS;
- create, edit, and delete DNS records;
- manage firewalls and rules, and attach a firewall to a VPS;
- open hPanel.

Hostinger actions taken by agents always wait for you.
