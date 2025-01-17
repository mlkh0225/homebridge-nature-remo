const axios = require('axios')
const { CronJob } = require('cron')

const DEFAULT_REQUEST_PARAMS = {
  url: 'https://api.nature.global/1/devices',
  method: 'GET'
}

const TIMEOUT = 2500
const REGEX_TIMEOUT_ERROR_CODE = /E(?:(?:SOCKET)?TIMEDOUT|CONNABORTED)/

let version
let Service
let Characteristic

module.exports = homebridge => {
  version = homebridge.version
  Service = homebridge.hap.Service
  Characteristic = homebridge.hap.Characteristic

  homebridge.registerAccessory('homebridge-nature-remo-sensor', 'remo-sensor', NatureRemoSensor, true)
}

class NatureRemoSensor {
  constructor (log, config, api) {
    log('homebridge API version: ' + version)
    log('NatureRemo Init')
    this.log = log
    this.config = config
    this.name = config.name
    this.mini = config.mini ?? false
    this.deviceName = config.deviceName
    this.accessToken = config.accessToken
    this.schedule = config.schedule || '*/5 * * * *'
    this.refreshTimestamp = Date.now()
    this.cache = config.cache ?? false

    this.previousSensorValue = null

    const sensors = config.sensors ?? {}
    const isEnabledTemperature = sensors.temperature !== false
    this.temperatureOffset = sensors.temperatureOffset || 0
    const isEnabledHumidity = this.mini !== true && sensors.humidity !== false
    this.humidityOffset = sensors.humidityOffset || 0
    const isEnabledLight = this.mini !== true && sensors.light !== false
    const isEnabledMotion = this.mini !== true && sensors.motion !== false
    const report = config.report || {}
    this.temperatureUrl = report.temperature || ""
    this.humidityUrl = report.humidity || ""
    this.lightUrl = report.light || ""
    this.motionUrl = report.motion || ""

    if (this.mini) {
      log('Humidity and light sensors are disabled in NatureRemo mini')
    }

    this.informationService = new Service.AccessoryInformation()
    this.temperatureSensorService = isEnabledTemperature ? new Service.TemperatureSensor(config.name) : null
    this.humiditySensorService = isEnabledHumidity ? new Service.HumiditySensor(config.name) : null
    this.lightSensorService = isEnabledLight ? new Service.LightSensor(config.name) : null
    this.motionSensorService = isEnabledMotion ? new Service.MotionSensor(config.name) : null

    this.job = new CronJob({
      cronTime: this.schedule,
      onTick: () => {
        this.log('> [Schedule]')
        this.request().then((data) => {
          this.previousSensorValue = this.parseResponseData(data)
          const { humidity, temperature, light, motion } = this.previousSensorValue
          if (this.temperatureSensorService) {
            this.log(`>>> [Update] temperature => ${temperature}`)
            this.temperatureSensorService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(temperature)
          }
          if (this.humiditySensorService) {
            this.log(`>>> [Update] humidity => ${humidity}`)
            this.humiditySensorService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(humidity)
          }
          if (this.lightSensorService) {
            this.log(`>>> [Update] light => ${light}`)
            this.lightSensorService.getCharacteristic(Characteristic.CurrentAmbientLightLevel).updateValue(light)
          }
          if (this.motionSensorService) {
            this.log(`>>> [Update] motion => ${motion}`)
            this.motionSensorService.getCharacteristic(Characteristic.MotionDetected).updateValue(motion)
          }
          this.log('> [Schedule] finish')
        }).catch((error) => {
          this.log(`>>> [Error] "${error}"`)
          this.previousSensorValue = null
          if (this.temperatureSensorService) {
            this.temperatureSensorService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(error)
          }
          if (this.humiditySensorService) {
            this.humiditySensorService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(error)
          }
          if (this.lightSensorService) {
            this.lightSensorService.getCharacteristic(Characteristic.CurrentAmbientLightLevel).updateValue(error)
          }
          if (this.motionSensorService) {
            this.motionSensorService.getCharacteristic(Characteristic.MotionDetected).updateValue(error)
          }
          this.log('> [Schedule] finish')
        })
      },
      runOnInit: true
    })
    this.job.start()

    this.getTemperature = this.createGetSensorFunc('temperature')
    this.getHumidity = this.createGetSensorFunc('humidity')
    this.getLight = this.createGetSensorFunc('light')
    this.getMotion = this.createGetSensorFunc('motion')
  }

  request (option) {
    if (!this.runningPromise) {
      const options = Object.assign({}, DEFAULT_REQUEST_PARAMS, {
        headers: {
          authorization: `Bearer ${this.accessToken}`
        }
      }, typeof option === 'object' ? option : {})

      this.log('>> [request] start')
      this.runningPromise = axios(options)
        .then((response) => {
          const limit = response.headers?.['x-rate-limit-limit'] ?? 0
          const remaining = response.headers?.['x-rate-limit-remaining'] ?? 0
          this.log(`>>> [response] status: ${response.status}, limit: ${remaining}/${limit}`)
          delete this.runningPromise
          return response.data
        })
        .catch((error) => {
          const response = error?.response
          const limit = response?.headers?.['x-rate-limit-limit'] ?? 0
          const remaining = response?.headers?.['x-rate-limit-remaining'] ?? 0
          this.log(`>>> [response] status: ${response?.status ?? 'NONE'}, limit: ${remaining}/${limit}`)
          delete this.runningPromise
          throw error
        })
    }
    return this.runningPromise
  }

  parseResponseData (responseData) {
    let humidity = null
    let temperature = null
    let light = null
    let motion = false

    let data

    if (this.deviceName) {
      data = (responseData || []).find((device, i) => {
        return device.name === this.deviceName
      })
    }
    data = data ?? (responseData || [])[0]

    if (data && data.newest_events) {
      if (this.getDviceInfo) {
        this.informationService
          .setCharacteristic(Characteristic.SerialNumber, data.serial_number)
          .setCharacteristic(Characteristic.FirmwareRevision, data.firmware_version)
      }
      if (data.newest_events.hu) {
        humidity = data.newest_events.hu.val - data.humidity_offset + this.humidityOffset
        if (this.humidityUrl)
          axios.get(this.humidityUrl + humidity)
      }
      if (data.newest_events.te) {
        temperature = data.newest_events.te.val - data.temperature_offset + this.temperatureOffset
        if (this.temperatureUrl)
          axios.get(this.temperatureUrl + temperature)
      }
      if (data.newest_events.il) {
        light = data.newest_events.il.val
        if (this.lightUrl)
          axios.get(this.lightUrl + light)
      }
      if (data.newest_events.mo) {
        this.log(`> [Getting] motion last triggered at => ${data.newest_events.mo.created_at}`)
        if ((this.refreshTimestamp - 30) < new Date(data.newest_events.mo.created_at))
        motion = true
        if (this.motionUrl)
          axios.get(this.motionUrl + motion)
        this.refreshTimestamp = Date.now()
      }
    }
    return { humidity, temperature, light, motion }
  }

  createGetSensorFunc (type) {
    return (callback) => {
      this.log(`> [Getting] ${type}`)
      const previousSensorValue = this.previousSensorValue?.[type]
      if (this.cache && typeof previousSensorValue === 'number') {
        this.log(`>>> [Getting] ${type} => ${previousSensorValue} (from cache)`)
        callback(null, previousSensorValue)
      } else {
        this.request({ timeout: TIMEOUT }).then((data) => {
          const value = this.parseResponseData(data)?.[type]
          this.log(`>>> [Getting] ${type} => ${value}`)
          callback(null, value)
        }).catch((error) => {
          this.log(`>>> [Error] "${error}"`)
          if (REGEX_TIMEOUT_ERROR_CODE.test(error.code) && typeof previousSensorValue === 'number') {
            callback(null, previousSensorValue)
          } else {
            callback(error)
          }
        })
      }
    }
  }

  getServices () {
    this.log(`start homebridge Server ${this.name}`)

    this.informationService
      .setCharacteristic(Characteristic.Manufacturer, 'Nature')
      .setCharacteristic(Characteristic.Model, 'Remo')
      .setCharacteristic(Characteristic.SerialNumber, '031-45-154')

    const services = [this.informationService]

    if (this.temperatureSensorService) {
      this.temperatureSensorService
        .getCharacteristic(Characteristic.CurrentTemperature)
        .on('get', this.getTemperature.bind(this))

      services.push(this.temperatureSensorService)
    }

    if (this.humiditySensorService) {
      this.humiditySensorService
        .getCharacteristic(Characteristic.CurrentRelativeHumidity)
        .on('get', this.getHumidity.bind(this))

      services.push(this.humiditySensorService)
    }

    if (this.lightSensorService) {
      this.lightSensorService
        .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
        .on('get', this.getLight.bind(this))

      services.push(this.lightSensorService)
    }

    if (this.motionSensorService) {
      this.motionSensorService
        .getCharacteristic(Characteristic.MotionDetected)
        .on('get', this.getMotion.bind(this))

      services.push(this.motionSensorService)
    }

    return services
  }
}
