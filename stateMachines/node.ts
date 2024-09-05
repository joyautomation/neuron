import EventEmitter from "node:events";
import {
  SparkplugCreateNodeInput,
  SparkplugDevice,
  SparkplugMetric,
  SparkplugNode,
  SparkplugNodeScanRates,
} from "../types.d.ts";
import { curry, pipe } from "npm:ramda";
import {
  createMqttClient,
  createSpbTopic,
  destroyMqttClient,
  Modify,
  publishDeviceData,
  publishNodeBirth,
  publishNodeData,
  publishNodeDeath,
  subscribeCurry,
} from "../mqtt.ts";
import {
  UMetric,
  UPayload,
} from "npm:sparkplug-payload/lib/sparkplugbpayload.js";
import { log } from "../log.ts";
import { getUnixTime } from "npm:date-fns";
import { someTrue } from "../utils.ts";
import { birthDevice, createDevice, killDevice } from "./device.ts";
import { setStateCurry } from "../utils.ts";
import { getMqttConfigFromSparkplug, on, onCurry } from "./utils.ts";
import { Listener, NodeEvent, type NodeTransition } from "./types.d.ts";
import { onMessage } from "./utils.ts";
import mqtt, { MqttClientEventCallbacks, OnConnectCallback } from "npm:mqtt";

const onConnect = (node: SparkplugNode) => {
  return () => {
    setNodeStateConnected(node);
    log.info(
      `${node.id} connected to ${node.brokerUrl} with user ${node.username}`
    );
    node.events.emit("connected");
    birthNode(node);
    Object.values(node.devices).forEach((device) => {
      killDevice(node, device);
      birthDevice(node, device);
    });
    killScans(node);
    node.scanRates = startScans(node);
  };
};

const onDisconnect = (node: SparkplugNode) => {
  return () => {
    setNodeStateDisconnected(node);
    log.info(`${node.id} disconnected`);
    node.events.emit("disconnected");
  };
};

export const nodeCommands = {
  rebirth: (node: SparkplugNode) =>
    pipe(killNode, disconnectNode, connectNode)(node),
};

const deriveNodeCommands = (message: UPayload) =>
  message.metrics?.map((metric) =>
    metric.name?.replace("Node Control/", "").toLowerCase()
  );

const onNodeCommand = (node: SparkplugNode) => {
  return (topic: string, message: UPayload) => {
    deriveNodeCommands(message)?.forEach((command) => {
      nodeCommands[command as keyof typeof nodeCommands]?.(node);
    });
  };
};

const setupNodeEvents = (node: SparkplugNode) => {
  if (node.mqtt) {
    pipe(
      onCurry<mqtt.MqttClient, "connect", OnConnectCallback>(
        "connect",
        onConnect(node)
      ),
      onCurry<mqtt.MqttClient, "message", mqtt.OnMessageCallback>(
        "message",
        onMessage(node)
      ),
      onCurry<mqtt.MqttClient, "disconnect", mqtt.OnDisconnectCallback>(
        "disconnect",
        onDisconnect(node)
      ),
      subscribeCurry(createSpbTopic("DCMD", getMqttConfigFromSparkplug(node)), {
        qos: 0,
      }),
      subscribeCurry(createSpbTopic("NCMD", getMqttConfigFromSparkplug(node)), {
        qos: 0,
      }),
      subscribeCurry("STATE/#", { qos: 1 })
    )(node.mqtt);
  }
  on<
    SparkplugNode["events"],
    NodeEvent,
    (topic: string, message: UPayload) => void
  >("ncmd", onNodeCommand(node), node.events);
};

const nodeTransitions = {
  connect: (node: SparkplugNode) => {
    node.mqtt = createMqttClient(getMqttConfigFromSparkplug(node), node.bdseq);
    return setupNodeEvents(node);
  },
  disconnect: (node: SparkplugNode) => {
    destroyMqttClient(node.mqtt);
    return setNodeStateDisconnected(node);
  },
  birth: (node: SparkplugNode) => {
    if (node.mqtt)
      publishNodeBirth(
        node.bdseq,
        node.seq,
        undefined,
        getNodeBirthPayload(Object.values(node.metrics)),
        getMqttConfigFromSparkplug(node),
        node.mqtt
      );
    return node;
  },
  death: (node: SparkplugNode) => {
    if (node.mqtt)
      publishNodeDeath(node.bdseq, getMqttConfigFromSparkplug(node), node.mqtt);
    return node;
  },
};

export const getNodeStateString = (node: SparkplugNode) => {
  if (node.states.disconnected) {
    return "disconnected";
  } else if (node.states.connected.born) {
    return "born";
  } else if (node.states.connected.dead) {
    return "dead";
  } else {
    return `unknown state: ${JSON.stringify(node.states)}`;
  }
};

const resetNodeState = (node: SparkplugNode) => {
  node.states = {
    connected: { born: false, dead: false },
    disconnected: false,
  };
  return node;
};

const deriveSetNodeState = (state: Partial<SparkplugNode["states"]>) =>
  pipe(
    resetNodeState,
    setStateCurry<SparkplugNode, SparkplugNode["states"]>(state)
  );
const setNodeStateConnected = deriveSetNodeState({
  connected: { born: false, dead: true },
});
const setNodeStateDisconnected = deriveSetNodeState({ disconnected: true });
const setNodeStateBorn = deriveSetNodeState({
  connected: { born: true, dead: false },
});
const setNodeStateDead = deriveSetNodeState({
  connected: { born: false, dead: true },
});

const changeNodeState = curry(
  (
    inRequiredState: (node: SparkplugNode) => boolean,
    notInRequiredStateLogText: string,
    transition: NodeTransition,
    node: SparkplugNode
  ) => {
    if (!inRequiredState(node)) {
      log.info(
        `${notInRequiredStateLogText}, it is currently: ${getNodeStateString(
          node
        )}`
      );
    } else {
      log.info(
        `transitioning from ${getNodeStateString(node)} to ${transition}`
      );
      nodeTransitions[transition](node);
    }
    return node;
  }
);

export const getNodeBirthPayload = (
  metrics: UMetric[] | undefined
): UPayload => ({
  timestamp: getUnixTime(new Date()),
  metrics: [
    {
      name: "Node Control/Rebirth",
      timestamp: getUnixTime(new Date()),
      type: "Boolean",
      value: false,
    },
    ...(metrics || []),
  ],
});

const birthNode: (node: SparkplugNode) => SparkplugNode = pipe(
  changeNodeState(
    (node: SparkplugNode) => node.states.connected.dead,
    "Node needs to be dead to be born",
    "birth"
  ) as Modify<SparkplugNode>,
  setNodeStateBorn as Modify<SparkplugNode>
);

const killNode = pipe(
  changeNodeState(
    (node: SparkplugNode) => node.states.connected.born,
    "Node needs to be born to be dead",
    "death"
  ) as Modify<SparkplugNode>,
  setNodeStateDead
);

const connectNode = changeNodeState(
  (node: SparkplugNode) => node.states.disconnected,
  "Node needs to be disconnected to be connected",
  "connect"
);

export const disconnectNode: (node: SparkplugNode) => SparkplugNode =
  changeNodeState(
    (node: SparkplugNode) => someTrue(...Object.values(node.states.connected)),
    "Node needs to be connected to be disconnected",
    "disconnect"
  );

export const publishMetrics = (
  node: SparkplugNode,
  scanRate?: number,
  metricSelector: (metric: SparkplugMetric) => boolean = () => true
) => {
  const nodeMetrics = Object.values(node.metrics).filter(
    (metric) => metric.scanRate === scanRate
  );
  if (nodeMetrics.length > 0 && node.mqtt)
    publishNodeData(
      node,
      {
        metrics: Object.values(node.metrics).filter(
          (metric) =>
            metricSelector(metric) &&
            (scanRate == null || metric.scanRate === scanRate)
        ),
      },
      getMqttConfigFromSparkplug(node),
      node.mqtt
    );
  Object.values(node.devices).forEach((device) => {
    const metrics = Object.values(device.metrics).filter(
      (metric) =>
        metricSelector(metric) &&
        (scanRate == null || metric.scanRate === scanRate)
    );
    if (metrics.length > 0 && node.mqtt) {
      publishDeviceData(
        node,
        { metrics },
        getMqttConfigFromSparkplug(node),
        node.mqtt,
        device.id
      );
    }
  });
};

export const startScans = (node: SparkplugNode) => {
  const scanRates = [
    ...new Set(
      [
        ...Object.values(node.metrics),
        ...Object.values(node.devices).reduce(
          (acc, devices) => acc.concat(Object.values(devices.metrics)),
          [] as SparkplugMetric[]
        ),
      ].map((metric) => metric.scanRate)
    ),
  ];
  return scanRates.reduce((acc, scanRate) => {
    if (scanRate != null)
      acc[scanRate] = setInterval(
        () => publishMetrics(node, scanRate),
        scanRate
      );
    return acc;
  }, {} as SparkplugNodeScanRates);
};

export const killScans = (node: SparkplugNode) => {
  Object.values(node.scanRates).forEach((scanRate) => clearInterval(scanRate));
};

export const createNode = (config: SparkplugCreateNodeInput): SparkplugNode => {
  const node = {
    ...config,
    bdseq: 0,
    seq: 0,
    mqtt: null,
    states: {
      connected: { born: false, dead: false },
      disconnected: true,
    },
    devices: Object.values(config.devices).reduce((acc, { id, metrics }) => {
      acc[id] = createDevice(id, metrics);
      return acc;
    }, {} as { [id: string]: SparkplugDevice }),
    events: new EventEmitter(),
    scanRates: {},
  };
  return connectNode(node);
};
